/*
 * Copyright (c) 2010-2014 BinarySEC SAS
 * Reverse proxy [http://www.binarysec.com]
 *
 * This file is part of Gate.js.
 *
 * Gate.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var http = require("http");
var https = require("https");
var url = require("url");
var cluster = require("cluster");
var fs = require("fs");
var crypto = require("crypto");
var tls = require("tls");
var EventEmitter = require('events');
var spdy = require("spdy");

var reverse = function() {
};

reverse.list = {};

reverse.log = function(gjs, connClose) {
	if(!connClose)
		connClose = gjs.response.statusCode;

	var version;
	if(gjs.request.isSpdy)
		version = "SPDY/"+gjs.request.spdyVersion;
	else
		version = "HTTP/"+gjs.request.httpVersion;


	gjs.root.lib.core.logger.commonLogger(
		'RVLOG',
		{
			version: version,
			site: gjs.site.name ? gjs.site.name : 'default',
			ip: gjs.request.remoteAddress,
			code: connClose,
			method: gjs.request.method,
			url: gjs.request.url,
			outBytes: gjs.request.gjsWriteBytes ? gjs.request.gjsWriteBytes : '0',
			userAgent: gjs.request.headers['user-agent'] ? gjs.request.headers['user-agent'] : '-',
			referer: gjs.request.headers.referer ? gjs.request.headers.referer : '-',
			cache: gjs.response.gjsCache ? gjs.response.gjsCache : 'miss',
			logAdd: gjs.logAdd
		}
	);
}

reverse.error = function(gjs, error) {
	var version;
	if(gjs.request.isSpdy)
		version = "SPDY/"+gjs.request.spdyVersion;
	else
		version = "HTTP/"+gjs.request.httpVersion;

	gjs.root.lib.core.logger.commonLogger(
		'RVERR',
		{
			version: version,
			site: gjs.site.name ? gjs.site.name : 'default',
			ip: gjs.request.remoteAddress,
			method: gjs.request.method,
			url: gjs.request.url,
			userAgent: gjs.request.headers['user-agent'] ? gjs.request.headers['user-agent'] : '-',
			referer: gjs.request.headers.referer ? gjs.request.headers.referer : '-',
			message: error,
			logAdd: gjs.logAdd
		}
	);
}

reverse.logpipe = function(gjs, src) {
	if(!gjs.request.gjsWriteBytes)
		gjs.request.gjsWriteBytes = 0;


	/* accumulate counter */
	src.on('data', function(data) {
		gjs.request.gjsWriteBytes += data.length;
	});

	/* on client close socket */
	gjs.request.on('close', function() {
		reverse.log(gjs, 499);
	});

	gjs.response.on('finish', function() {
		reverse.log(gjs);
	});

	src.pipe(gjs.response);
}

reverse.loader = function(gjs) {
	reverse.events = new EventEmitter;
	reverse.sites = new gjs.lib.http.site(gjs, 'pipeReverse', 'reverseSites');
	reverse.sites.reload();

	if (cluster.isMaster) {
		/* background checker */
		reverse.sitesFaulty = {};

		function backgroundChecker(input) {
			/* take the node */
			var node = input.msg.node;

			/* take the site */
			var sNode = null;
			var site = gjs.lib.http.reverse.sites.search(input.msg.site, input.msg.ifaceName);
			if(site)
				if(site.proxyStream[node._name][node._key])
					if(site.proxyStream[node._name][node._key][node._index])
						sNode = site.proxyStream[node._name][node._key][node._index];

			/* do not need more action */
			if(!sNode || sNode.isFaulty != true) {
				delete reverse.sitesFaulty[input.hash];
				return;
			}

			/* create http req options */
			var options = {
				host: node.host,
				port: input.msg.port,
				path: '/is-your-website-works',
				method: 'GET',
				headers: {
					Host: input.msg.site,
					"User-Agent": "gatejs monitor"
				},
				rejectUnauthorized: false,
				servername: input.msg.site,
				agent: false
			};

			var flowSelect = http;
			if(input.msg.https == true)
				flowSelect = https;

			var context = reverse.sitesFaulty[input.hash];

			var req = flowSelect.request(options, function(res) {
				var context = reverse.sitesFaulty[input.hash];
				if(!context)
					return;

				gjs.lib.core.ipc.send('LFW', 'proxyPassWork', {
					site: context._site,
					node: context._node
				});

				if(context._timer)
					clearTimeout(context._timer);

				clearTimeout(res.socket.timeoutId);
				delete reverse.sitesFaulty[input.hash];
			});

			req.on('error', function (error) {
				var context = reverse.sitesFaulty[input.hash];
				if(!context)
					return;

				if(context._timer)
					clearTimeout(context._timer);
				context._timer = setTimeout(
					backgroundChecker,
					1000,
					input
				);
			});

			function socketErrorDetection(socket) {
				req.abort();
				socket.destroy();

				var context = reverse.sitesFaulty[input.hash];
				if(!context)
					return;

				clearTimeout(socket.timeoutId);
				if(context._timer)
					clearTimeout(context._timer);
				context._timer = setTimeout(
					backgroundChecker,
					1000,
					input
				);
			}

			req.on('socket', function (socket) {
				socket.timeoutId = setTimeout(
					socketErrorDetection,
					10000,
					socket
				);
				socket.on('connect', function() {
					clearTimeout(socket.timeoutId);
				});

			});

			req.end();
		}

		gjs.lib.core.ipc.on('proxyPassFaulty', function(gjs, data) {
			var d = data.msg.node;

			var s = gjs.lib.http.reverse.sites.search(data.msg.site, data.msg.ifaceName);
			if(!s)
				return;

			/* group by ip and port */
			var hash = s.name+':'+d.host+':'+data.msg.port;
			if(!reverse.sitesFaulty[hash]) {
				reverse.sitesFaulty[hash] = {
					_site: data.msg.site,
					_host: d.host,
					_port: data.msg.port,
					_node: data.msg.node,
					_timer: setTimeout(
						backgroundChecker,
						2000,
						{hash: hash, msg: data.msg, site: s, ifaceName: data.msg.ifaceName }
					)
				};
			}
		});

		/* Logging */
		var logger = gjs.lib.core.logger;

		/* create logging receiver */
		var processLog = function(req) {

			var logAdd = req.msg.logAdd ? req.msg.logAdd : '';
			var inline =
				req.msg.site+' - '+
				req.msg.ip+' '+
				req.msg.version+' '+
				req.msg.cache.toUpperCase()+' '+
				req.msg.method+' '+
				req.msg.code+' '+
				req.msg.url+' '+
				'"'+req.msg.userAgent+'" '+
				req.msg.outBytes+' '+
				req.msg.referer+
				logAdd
			;

			/* write log */
			var f = logger.selectFile(req.msg.site, 'access');
			if(f)
				f.write(inline);
		}
		var processError = function(req) {
			/* write log */
			var f = logger.selectFile(req.msg.site, 'error');
			if(f)
				f.write(req.msg.message);
		}

		logger.typeTab['RVLOG'] = processLog;
		logger.typeTab['RVERR'] = processError;
		return;
	}

	var processRequest = function(server, request, response) {
		if(!request.socket || !request.socket.remoteAddress)  {
			if(request.socket)
				request.socket.destroy();

			response.end();
			console.log('User disconnect before IP address population');
			return;
		}

		request.remoteAddress = request.socket.remoteAddress.slice(0);

		response.on('error', function(e) { });

		var pipe = gjs.lib.core.pipeline.create(null, null, function() {
			gjs.lib.http.error.renderArray({
				pipe: pipe,
				code: 513,
				tpl: "5xx",
				log: false,
				title:  "Pipeline terminated",
				explain: "Pipeline did not execute a breaking opcode"
			});
		});

		pipe.logAdd = '';
		pipe.reverse = true;
		pipe.root = gjs;
		pipe.request = request;
		pipe.response = response;
		pipe.server = server;

		//gjs.lib.core.stats.http(pipe);

		/* parse the URL */
		try {
			pipe.request.urlParse = url.parse(request.url, true);
		} catch(e) {
			gjs.lib.core.logger.error('URL Parse error on from '+request.remoteAddress);
			reverse.events.emit("urlError", pipe);
			request.socket.destroy();
			return;
		}

		/* lookup website */
		pipe.site = reverse.sites.search(request.headers.host, server.gjsKey);
		if(!pipe.site) {
			pipe.site = reverse.sites.search('_', server.gjsKey);
			if(!pipe.site) {
				pipe.response.end();
				/*
				gjs.lib.http.error.renderArray({
					pipe: pipe,
					code: 404,
					tpl: "4xx",
					log: false,
					title:  "Not found",
					explain: "No default website"
				});
				*/
				return;
			}
		}

		reverse.events.emit("request", pipe);

		/* lookup little FS */
		var lfs = gjs.lib.http.littleFs.process(pipe);
		if(lfs == true)
			return;

		/* get iface */
		var iface = reverse.list[server.gjsKey];
		if(!iface) {
			gjs.lib.http.error.renderArray({
				pipe: pipe,
				code: 500,
				tpl: "5xx",
				log: false,
				title:  "Internal server error",
				explain: "no iface found, fatal error"
			});
			gjs.lib.core.logger.error('No interface found for key '+server.gjsKey+' from '+request.remoteAddress);
			return;
		}
		pipe.iface = iface;

		/* scan regex */
		pipe.location = false;
		if(pipe.site.locations) {
			for(var a in pipe.site.locations) {
				var s = pipe.site.locations[a];
				if(!s.regex)
					s.regex = /.*/;
				if(s.regex.test(request.url)) {
					pipe.location = s;
					break;
				}
			}
		}
		if(pipe.location == false) {
			gjs.lib.http.error.renderArray({
				pipe: pipe,
				code: 500,
				tpl: "5xx",
				log: false,
				title:  "Internal server error",
				explain: "No locations found for this website"
			});
			return;
		}
		if(!pipe.location.pipeline instanceof Array) {
			gjs.lib.http.error.renderArray({
				pipe: pipe,
				code: 500,
				tpl: "5xx",
				log: false,
				title:  "Internal server error",
				explain: "Invalid pipeline format for this website"
			});
			return;
		}

		gjs.lib.http.postMgr.init(pipe);

		/* add socket keep alive */
		if(request.httpVersion == '1.1') {
			pipe.response.on('response', function(res, from) {
				res.gjsSetHeader('Connection', 'keep-alive');
				res.gjsSetHeader('Keep-Alive', 'timeout=300, max=1000');
			});
		}

		pipe.update(reverse.sites.opcodes, pipe.location.pipeline);

		/* execute pipeline */
		pipe.request.on('close', function() {
			pipe.stop();
		});

		pipe.resume();
		pipe.execute();
	};

	var processUpgrade = function(server, request, socket) {
		request.remoteAddress = request.socket.remoteAddress;

		socket.setTimeout(1000 * 60 * 300);

		socket.on('error', function(e) {
			console.log('wss', e);
		});

		var pipe = gjs.lib.core.pipeline.create(null, null, function() {
			gjs.lib.core.logger.error('Pipeline error while HTTP Upgrade '+
					server.config.pipeline+' from '+request.remoteAddress);
			socket.end('HTTP/'+request.httpVersion+' 500 Internal server error\r\n' +
			       '\r\n');
			return(false);
		});

		pipe.logAdd = '';
		pipe.reverse = true;
		pipe.root = gjs;
		pipe.request = request;
		pipe.response = socket;
		pipe.server = server;
		pipe.upgrade = true;
		pipe.caller = "upgrade";

		gjs.lib.core.stats.http(pipe);

		/* parse the URL */
		try {
			pipe.request.urlParse = url.parse(request.url, true);
		} catch(e) {
			gjs.lib.core.logger.error('URL Parse error on from '+request.remoteAddress);
			request.socket.destroy();
			return;
		}

		/* lookup website */
		pipe.site = reverse.sites.search(request.headers.host, server.gjsKey);
		if(!pipe.site) {
			pipe.site = reverse.sites.search('_', server.gjsKey);
			if(!pipe.site) {
				pipe.response.destroy();
				return;
			}
		}

		reverse.events.emit("request", pipe);

		/* get iface */
		var iface = reverse.list[server.gjsKey];
		if(!iface) {
			gjs.lib.http.error.renderArray({
				pipe: pipe,
				code: 500,
				tpl: "5xx",
				log: false,
				title:  "Internal server error",
				explain: "no iface found, fatal error"
			});
			gjs.lib.core.logger.error('No interface found for key '+server.gjsKey+' from '+request.remoteAddress);
			return;
		}
		pipe.iface = iface;

		/* scan regex */
		pipe.location = false;
		if(pipe.site.locations) {
			for(var a in pipe.site.locations) {
				var s = pipe.site.locations[a];
				if(!s.regex)
					s.regex = /.*/;
				if(s.regex.test(request.url)) {
					pipe.location = s;
					break;
				}
			}
		}
		if(pipe.location == false) {
			gjs.lib.http.error.renderArray({
				pipe: pipe,
				code: 500,
				tpl: "5xx",
				log: false,
				title:  "Internal server error",
				explain: "No locations found for this website"
			});
			return;
		}
		if(!pipe.location.pipeline instanceof Array) {
			gjs.lib.http.error.renderArray({
				pipe: pipe,
				code: 500,
				tpl: "5xx",
				log: false,
				title:  "Internal server error",
				explain: "Invalid pipeline format for this website"
			});
			return;
		}

		pipe.update(reverse.sites.opcodes, pipe.location.pipeline);

		/* execute pipeline */
		pipe.request.on('close', function() {
			pipe.stop();
		});

		pipe.resume();
		pipe.execute();
	};

	var slowLoris = function(socket) {
		console.log("Probable SlowLoris attack from "+socket.remoteAddress+", closing.");
		clearInterval(socket.gjs.interval);
		socket.destroy();
	}

	var bindHttpServer = function(key, sc) {
		gjs.events.emit('rvInterfaceCreate', sc);

		var iface = http.createServer(function(request, response) {
			request.socket.inUse = true;

			response.on('finish', function() {
				if(request.socket._handle)
					request.socket.inUse = false;
			});

			processRequest(this, request, response);

		});

		iface.gjsKey = key;
		iface.allowHalfOpen = false;
		iface.config = sc;

		/* select agent */
		if(sc.isTproxy == true && gjs.lib.http.tproxy.enabled)
			iface.agent = gjs.lib.http.agent.httpTproxy;
		else
			iface.agent = gjs.lib.http.agent.http;

/*
		iface.on('socket', (function(socket) {
			gjs.lib.core.graceful.push(socket);
			gjs.lib.core.stats.diffuse('httpWaiting', gjs.lib.core.stats.action.add, 1);

			socket.setTimeout(300000);

			socket.on('close', function () {
				socket.inUse = false;
				gjs.lib.core.graceful.release(socket);
				gjs.lib.core.stats.diffuse('httpWaiting', gjs.lib.core.stats.action.sub, 1);
			});
		}));
*/

		iface.on('upgrade', function(request, socket, head) {
			if(request.method != 'GET') {
				gjs.lib.core.logger.error('Bad method while socket Upgrade from '+socket.remoteAddress);
				socket.destroy();
				return;
			}

			request.socket.inUse = true;

			socket.on('close', function() {
				if(request.socket._handle)
					request.socket.inUse = false;
			});

			processUpgrade(this, request, socket);
		});

		iface.on('listening', function() {
			gjs.lib.core.logger.system("Binding HTTP reverse proxy on "+sc.address+":"+sc.port);
			iface.working = true;
		});

		iface.on('error', function(e) {
			gjs.lib.core.logger.error('HTTP reverse error for instance '+key+': '+e);
			console.log('* HTTP reverse error for instance '+key+': '+e);
		});

		gjs.events.emit('rvInterfaceBinding', iface, sc);

		/* listen */
		if(sc.isTproxy == true && gjs.lib.http.tproxy.enabled)
			iface.listenTproxy(sc.port, sc.address);
		else
			iface.listen(sc.port, sc.address);

		return(iface);
	}


	var bindHttpsServer = function(key, sc) {
		if(!gjs.lib.http.lookupSSLFile(sc)) {
			console.log("Can not create HTTPS server on "+sc.address+':'+sc.port);
			return(false);
		}

		gjs.lib.http.hardeningSSL(sc);

		sc.SNICallback = function(hostname, cb) {

			var site = reverse.sites.search(hostname, key);

			if(site && site.sslSNI) {
				/* can not use SNI  */
				if(site.sslSNI.usable == false) {
					cb(null, null);
					return(false);
				}

				/* SNI resolved */
				if(site.sslSNI.resolv) {
					cb(null, site.sslSNI.crypto.context);
					return(true);
				}

				/* ok wegjsite has SNI certificate check files */
				if(!gjs.lib.http.lookupSSLFile(site.sslSNI)) {
					site.sslSNI.usable = false;
					site.sslSNI.resolv = true;
					cb(null, null);
					return(false);
				}
				site.sslSNI.usable = true;
				site.sslSNI.resolv = true;

				gjs.lib.http.hardeningSSL(site.sslSNI);

				/* associate crypto Credentials */
				site.sslSNI.crypto = tls.createSecureContext(site.sslSNI);

				/* set TLS context */
				cb(null, site.sslSNI.crypto.context);
				return(true);
			}
			cb(null, null);
			return(false);
		}

		var int = https;
		if(sc.spdy)
			int = spdy;

		gjs.events.emit('rvInterfaceCreate', sc);

		var iface = int.createServer(sc, function(request, response) {
			request.socket.inUse = true;

			response.on('finish', function() {
				if(request.socket._handle)
					request.socket.inUse = false;
			});

			processRequest(this, request, response);
		});

		iface.gjsKey = key;
		iface.allowHalfOpen = false;
		iface.config = sc;

		/* select agent */
		if(sc.spdy == true) {
			if(sc.isTproxy == true && gjs.lib.http.tproxy.enabled)
				iface.agent = gjs.lib.http.agent.spdyTproxy;
			else
				iface.agent = gjs.lib.http.agent.spdy;
		}
		else if(sc.isTproxy == true && gjs.lib.http.tproxy.enabled)
			iface.agent = gjs.lib.http.agent.httpsTproxy;
		else
			iface.agent = gjs.lib.http.agent.https;

		/* process upgrade request */
		iface.on('upgrade', function(request, socket, head) {
			if(request.method != 'GET') {
				gjs.lib.core.logger.error('Bad method while socket Upgrade from '+socket.remoteAddress);
				socket.destroy();
				return;
			}

			request.socket.inUse = true;

			socket.on('close', function() {
				if(request.socket._handle)
					request.socket.inUse = false;
			});

			processUpgrade(this, request, socket);
		});

/*
		iface.on('socket', (function(socket) {
			gjs.lib.core.graceful.push(socket);

			socket.setTimeout(300000);

			socket.on('close', function () {
				socket.inUse = false;
				gjs.lib.core.graceful.release(socket);
			});
		}));
*/

		iface.on('listening', function() {
			gjs.lib.core.logger.system("Binding HTTPS reverse proxy on "+sc.address+":"+sc.port);
			iface.working = true;
		});

		iface.on('error', function(e) {
			gjs.lib.core.logger.error('HTTPS reverse error for instance '+key+': '+e);
			console.log('* HTTPS reverse error for instance '+key+': '+e);
		});

		gjs.events.emit('rvInterfaceBinding', iface, sc);

		/* listen */
		if(sc.isTproxy == true && gjs.lib.http.tproxy.enabled)
			iface.listenTproxy(sc.port, sc.address);
		else
			iface.listen(sc.port, sc.address);

		return(iface);
	}

	/*
	 * Associate interface and configuration
	 */
	function processConfiguration(key, o) {
		if(o.type == 'reverse') {
			if(!reverse.list[key]) {
				reverse.list[key] = {
					sites: [],
					ifaces: []
				};
			}
			/* defaulting */
			if(!o.port)
				o.port = o.ssl == true ? 443 : 80;
			if(o.ssl == true)
				reverse.list[key].ifaces.push(bindHttpsServer(key, o));
			else
				reverse.list[key].ifaces.push(bindHttpServer(key, o));
		}
	}

	/*
	 * Follow configuration
	 */
	for(var a in gjs.serverConfig.http) {
		var sc = gjs.serverConfig.http[a];
		if(sc instanceof Array) {
			for(var b in sc)
				processConfiguration(a, sc[b]);
		}
		else if(sc instanceof Object)
			processConfiguration(a, sc);
	}


	function gracefulReceiver() {
		console.log('Process receive graceful message');
		for(var a in reverse.list) {
			var config = reverse.list[a];

			/* close all server accept */
			for(var b in config.ifaces) {
				var server = config.ifaces[b];
				if(server.working == true) {
					server.isClosing = true;
					server.close(function() { });
				}
			}
		}

		gjs.lib.core.ipc.removeListener('system:graceful:process', gracefulReceiver);
	}

	/* add graceful receiver */
	gjs.lib.core.ipc.on('system:graceful:process', gracefulReceiver);

	return(false);

}

module.exports = reverse;
