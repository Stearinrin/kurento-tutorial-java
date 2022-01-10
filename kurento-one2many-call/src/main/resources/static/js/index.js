/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var ws = new WebSocket('wss://' + location.host + '/call');
var video;
var webRtcPeer;
var isRemote = null;
var jsonDump = [];

var latencyStats = {
	get stats() {
		return this._stats;
	},
	set stats(value) {
		this._stats = value;
	}
};

window.onload = function() {
	console = new Console();
	video = document.getElementById('video');
	disableStopButton();
}

window.onbeforeunload = function() {
	ws.close();
}

ws.onmessage = function(message) {
	var parsedMessage = JSON.parse(message.data);
	console.info('Received message: ' + message.data);

	switch (parsedMessage.id) {
	case 'presenterResponse':
		presenterResponse(parsedMessage);
		break;
	case 'viewerResponse':
		viewerResponse(parsedMessage);
		break;
	case 'iceCandidate':
		webRtcPeer.addIceCandidate(parsedMessage.candidate, function(error) {
			if (error)
				return console.error('Error adding candidate: ' + error);
		});
		break;
	case 'mediaStateChanged':
		// activateStatsTimeout();
		break;
	case 'activateStatsTimeout':
		activateStatsTimeout();
		break;
	case 'latencyStatsResponse':
		latencyStatsResponse(parsedMessage);
		break;
	case 'stopCommunication':
		dispose();
		dump();
		break;
	default:
		console.error('Unrecognized message', parsedMessage);
	}
}

function presenterResponse(message) {
	if (message.response != 'accepted') {
		var errorMsg = message.message ? message.message : 'Unknow error';
		console.info('Call not accepted for the following reason: ' + errorMsg);
		dispose();
	} else {
		webRtcPeer.processAnswer(message.sdpAnswer, function(error) {
			if (error)
				return console.error(error);
		});
	}
}

function viewerResponse(message) {
	if (message.response != 'accepted') {
		var errorMsg = message.message ? message.message : 'Unknow error';
		console.info('Call not accepted for the following reason: ' + errorMsg);
		dispose();
	} else {
		webRtcPeer.processAnswer(message.sdpAnswer, function(error) {
			if (error)
				return console.error(error);
		});
	}
}

function latencyStatsResponse(message) {
	if (message.response != 'accepted') {
		var errorMsg = message.message ? message.message : 'Unknow error';
		console.info('Request was not accepted for the following reason: ' + errorMsg);
		latencyStats = errorMsg;
	} else {	
		// message.type === "data"
		stats = message.data;
		console.log("---------- [endpoint data] ----------");
		console.log(stats);
	
		// set latency stats
		latencyStats = stats;
	}
}

function activateStatsTimeout() {
	setTimeout(function() {
		if (!webRtcPeer) return;

		let now = new Date();
		let time_data = {
			'timestamp': now.getTime(),
			'stats': printStats(),
		}
		jsonDump.push(time_data);

		activateStatsTimeout();
	}, 1000);
}

function printStats() {
	var stats = {};

	if (!webRtcPeer) {
		return console.error("Error: Cannot get stats from null webRtcPeer");
	}

	stats['browser_send'] = getBrowserOutgoingVideoStats(webRtcPeer, function(error, stats) {
		if (error) {
			console.warn("Warning: could not gather browser outgoing stats: " + error);
			return error;
		}
		document.getElementById('browserOutgoingSsrc').innerHTML = stats.ssrc;
		document.getElementById('browserPacketsSent').innerHTML = stats.packetsSent;
		document.getElementById('browserBytesSent').innerHTML = stats.bytesSent;
		document.getElementById('browserNackReceived').innerHTML = stats.nackCount;
		document.getElementById('browserFirReceived').innerHTML = stats.firCount;
		document.getElementById('browserPliReceived').innerHTML = stats.pliCount;
		document.getElementById('browserOutgoingIceRtt').innerHTML = stats.iceRoundTripTime;
		document.getElementById('browserOutgoingAvailableBitrate').innerHTML = stats.availableBitrate;
	});

	stats['browser_recv'] = getBrowserIncomingVideoStats(webRtcPeer, function(error, stats) {
		if (error) {
			console.warn("Warning: could not gather browser incoming stats: " + error);
			return error;
		}
		document.getElementById('browserIncomingSsrc').innerHTML = stats.ssrc;
		document.getElementById('browserPacketsReceived').innerHTML = stats.packetsReceived;
		document.getElementById('browserBytesReceived').innerHTML = stats.bytesReceived;
		document.getElementById('browserIncomingPacketsLost').innerHTML = stats.packetsLost;
		document.getElementById('browserIncomingJitter').innerHTML = stats.jitter;
		document.getElementById('browserNackSent').innerHTML = stats.nackCount;
		document.getElementById('browserFirSent').innerHTML = stats.firCount;
		document.getElementById('browserPliSent').innerHTML = stats.pliCount;
		document.getElementById('browserIncomingIceRtt').innerHTML = stats.iceRoundTripTime;
		document.getElementById('browserIncomingAvailableBitrate').innerHTML = stats.availableBitrate;
	});

	stats['latency'] = getLatencyStats(webRtcPeer, function(error, stats) {
		if (error) {
			console.warn("Warning: could not gather latency stats: " + error);
			return error;
		}
		console.log(stats);
		document.getElementById('KmsE2ELatency').innerHTML = stats.video.E2ELatency + " milliseconds";
		document.getElementById('BrowserE2ELatency').innerHTML = stats.browserE2ELatency + " seconds";

		return stats;
	});

	latencyStats = {};

	return stats;
}

/*
Parameters:

peerMediaElement: valid reference of a media element.

mediaTrack: one of
  AudioTrack
  VideoTrack
*/

function getLocalPeerStats(peerMediaElement, mediaTrack, callback){
	if(!peerMediaElement) return callback("Cannot get stats from a null peer media element");
	if(!mediaTrack) return callback("Non existent local track: cannot read stats");

	let retVal = {};

	peerMediaElement
		.getStats(mediaTrack)
		.then(function(stats) {
			retVal["isRemote"] = false;

			// "stats" is of type RTCStatsReport
			// https://www.w3.org/TR/webrtc/#rtcstatsreport-object
			// https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsReport
			// which behaves like a Map
			// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map
			const statsArr = Array.from(stats.values());

			// "report.type" is of type RTCStatsType
			// https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsType
			const reportsRtp = statsArr.filter(report => {
				return report.type === "outbound-rtp";
			});
			const reportsCandidatePair = statsArr.filter(report => {
				return report.type === "candidate-pair";
			});
			const reportsCodec = statsArr.filter(report => {
				return report.type === "codec";
			});

			// Get the first RTP report to import its stats
			if (reportsRtp.length < 1) {
				console.warn("No RTP reports found in RTCStats");
				return;
			}
			const reportRtp = reportsRtp[0];

			console.log("---------- [browser out] ----------");
			console.log(reportRtp);
			// RTCStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcstats
			retVal["timestamp"] = reportRtp.timestamp;

			// RTCRtpStreamStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcrtpstreamstats
			retVal["ssrc"] = reportRtp.ssrc;

			// RTCSentRtpStreamStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcsentrtpstreamstats
			retVal["packetsSent"] = reportRtp.packetsSent;
			retVal["bytesSent"] = reportRtp.bytesSent;

			// RTCOutboundRtpStreamStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcoutboundrtpstreamstats
			retVal["nackCount"] = reportRtp.nackCount;
			if (reportRtp.firCount) {
				retVal["firCount"] = reportRtp.firCount;
			}
			if (reportRtp.pliCount) {
				retVal["pliCount"] = reportRtp.pliCount;
			}
			if (reportRtp.sliCount) {
				retVal["sliCount"] = reportRtp.sliCount;
			}
			if (reportRtp.framesEncoded) {
				retVal["framesEncoded"] = reportRtp.framesEncoded;
			}
			if (reportRtp.qpSum) {
				retVal["qpSum"] = reportRtp.qpSum;
			}

			//  RTCIceCandidatePairStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcicecandidatepairstats
			const matchCandidatePairs = reportsCandidatePair.filter(pair => {
				return pair.transportId === reportRtp.transportId;
			});
			if (matchCandidatePairs.length > 0) {
				retVal["iceRoundTripTime"] = matchCandidatePairs[0].currentRoundTripTime;
				retVal["availableBitrate"] = matchCandidatePairs[0].availableOutgoingBitrate;
			}

			return callback(null, retVal);
		})
		.catch(function(err) {
			retVal["error"] = err 
			return callback(err, null);
		});
	
	return retVal;
}
  
function getRemotePeerStats(peerMediaElement, mediaTrack, callback){
	if(!peerMediaElement) return callback("Cannot get stats from a null peer media element");
	if(!mediaTrack) return callback("Non existent local track: cannot read stats");
  
	let retVal = {};
  
	peerMediaElement
		.getStats(mediaTrack)
		.then(function(stats) {
			retVal["isRemote"] = true;
	
			// "stats" is of type RTCStatsReport
			// https://www.w3.org/TR/webrtc/#rtcstatsreport-object
			// https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsReport
			// which behaves like a Map
			// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map
			const statsArr = Array.from(stats.values());
	
			// "report.type" is of type RTCStatsType
			// https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsType
			const reportsRtp = statsArr.filter(report => {
				return report.type === "inbound-rtp";
			});
			const reportsCandidatePair = statsArr.filter(report => {
				return report.type === "candidate-pair";
			});
			const reportsCodec = statsArr.filter(report => {
				return report.type === "codec";
			});
	
			// Get the first RTP report to import its stats
			if (reportsRtp.length < 1) {
				onsole.warn("No RTP reports found in RTCStats");
				return;
			}
			const reportRtp = reportsRtp[0];
	
			console.log("---------- [browser in] ----------");
			console.log(reportRtp);
			// RTCStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcstats
			retVal["timestamp"] = reportRtp.timestamp;
	
			// RTCRtpStreamStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcrtpstreamstats
			retVal["ssrc"] = reportRtp.ssrc;
	
			// RTCReceivedRtpStreamStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcreceivedrtpstreamstats
			retVal["packetsReceived"] = reportRtp.packetsReceived;
			retVal["packetsDiscarded"] = reportRtp.packetsDiscarded;
			retVal["packetsLost"] = reportRtp.packetsLost;
			retVal["jitter"] = reportRtp.jitter;
	
			// RTCInboundRtpStreamStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcinboundrtpstreamstats
			retVal["bytesReceived"] = reportRtp.bytesReceived;
			retVal["nackCount"] = reportRtp.nackCount;
			if (reportRtp.firCount) {
				retVal["firCount"] = reportRtp.firCount;
			}
			if (reportRtp.pliCount) {
				retVal["pliCount"] = reportRtp.pliCount;
			}
			if (reportRtp.sliCount) {
				retVal["sliCount"] = reportRtp.sliCount;
			}
			if (reportRtp.framesDecoded) {
				retVal["framesDecoded"] = reportRtp.framesDecoded;
			}
			if (reportRtp.qpSum) {
				retVal["qpSum"] = reportRtp.qpSum;
			}
	
			//  RTCIceCandidatePairStats
			// https://w3c.github.io/webrtc-stats/#dom-rtcicecandidatepairstats
			const matchCandidatePairs = reportsCandidatePair.filter(pair => {
			return pair.transportId === reportRtp.transportId;
			});
			if (matchCandidatePairs.length > 0) {
				retVal["iceRoundTripTime"] = matchCandidatePairs[0].currentRoundTripTime;
				retVal["availableBitrate"] = matchCandidatePairs[0].availableIncomingBitrate;
			}
	
			return callback(null, retVal);
	  	})
		.catch(function(err) {
			retVal["error"] = err 
			return callback(err, null);
		});
  
	return retVal;
}

function getBrowserOutgoingVideoStats(webRtcPeer, callback) {
	if (!webRtcPeer) return callback("Cannot get stats from null webRtcPeer");
	let peerConnection = webRtcPeer.peerConnection;
  
	if (!peerConnection) return callback("Cannot get stats from null peerConnection");
	let localStream = peerConnection.getLocalStreams()[0];
	
	if (!localStream) return callback("Non existent local stream: cannot read stats");
	let localAudioTrack = localStream.getAudioTracks()[0];
	let localVideoTrack = localStream.getVideoTracks()[0];
	
	if (!localAudioTrack) return callback("Non existent local audio track: cannot read stats");
	if (!localVideoTrack) return callback("Non existent local video track: cannot read stats");
  
	let rtrn = {
		audio: {},
		video: {}
	};
  
	// audio track
	rtrn['audio'] = getLocalPeerStats(peerConnection, localAudioTrack, callback);
  
	// video track
	rtrn['video'] = getLocalPeerStats(peerConnection, localVideoTrack, callback);
	
	return rtrn;
}

function getBrowserIncomingVideoStats(webRtcPeer, callback) {
	if (!webRtcPeer) return callback("Cannot get stats from null webRtcPeer");
	var peerConnection = webRtcPeer.peerConnection;

	if (!peerConnection) return callback("Cannot get stats from null peerConnection");
	var remoteStream = peerConnection.getRemoteStreams()[0];
	
	if (!remoteStream) return callback("Non existent remote stream: cannot read stats")
	var remoteAudioTrack = remoteStream.getAudioTracks()[0];
	var remoteVideoTrack = remoteStream.getVideoTracks()[0];
	
	if (!remoteAudioTrack) return callback("Non existent remote audio track: cannot read stats");
	if (!remoteVideoTrack) return callback("Non existent remote video track: cannot read stats");

	let rtrn = {
		audio: {},
		video: {}
	};

	// audio track
	rtrn['audio'] = getRemotePeerStats(peerConnection, remoteAudioTrack, callback);

	// video track
	rtrn['video'] = getRemotePeerStats(peerConnection, remoteVideoTrack, callback);

	return rtrn;
}

function getLatencyStats(webRtcPeer, callback) {
	var message = {
		id: 'getLatencyStats',
		timestamp: new Date().getTime()
	}

	if (isRemote === true) {
		sendMessage(message);
	} else if (isRemote === false) {
		message['isPresenter'] = true;
		sendMessage(message);
		return callback("Cannot get latency stats from local peer");
	} else {
		return callback("The isRemote flag is not set or unknown value");
	}	
	
	// check empty
	if (!latencyStats) {
		return callback("Non existent latency stats");
	} else {
		let rtrn = {
			'audio': {},
			'video': {}
		};
		let stats = latencyStats;
		let now = new Date().getTime();

		rtrn['timestamp'] = stats["timestampMillis"];
		rtrn['audio']['inputLatency'] = stats["inputAudioLatency"] / 1000000;
		rtrn['audio']['E2ELatency'] = stats["audioE2ELatency"] / 1000000;
		rtrn['video']['inputLatency'] = stats["inputVideoLatency"] / 1000000;
		rtrn['video']['E2ELatency'] = stats["videoE2ELatency"] / 1000000;
		if (stats["presenterTimestamp"] !== undefined) {
			rtrn['browserE2ELatency'] = (now - stats["presenterTimestamp"]) / 1000;
		}
		
		return callback(null, rtrn);
	}
}

function presenter() {
	if (!webRtcPeer) {
		showSpinner(video);

		var options = {
			localVideo : video,
			onicecandidate : onIceCandidate
		}
		webRtcPeer = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options,
				function(error) {
					if (error) {
						return console.error(error);
					}
					webRtcPeer.generateOffer(onOfferPresenter);
				});

		isRemote = false;
		enableStopButton();
	}
}

function onOfferPresenter(error, offerSdp) {
	if (error)
		return console.error('Error generating the offer');
	console.info('Invoking SDP offer callback function ' + location.host);
	var message = {
		id : 'presenter',
		sdpOffer : offerSdp
	}
	sendMessage(message);
}

function viewer() {
	if (!webRtcPeer) {
		showSpinner(video);

		var options = {
			remoteVideo : video,
			onicecandidate : onIceCandidate
		}
		webRtcPeer = new kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options,
				function(error) {
					if (error) {
						return console.error(error);
					}
					this.generateOffer(onOfferViewer);
				});

		isRemote = true;
		enableStopButton();
	}
}

function onOfferViewer(error, offerSdp) {
	if (error)
		return console.error('Error generating the offer');
	console.info('Invoking SDP offer callback function ' + location.host);
	var message = {
		id : 'viewer',
		sdpOffer : offerSdp
	}
	sendMessage(message);
}

function onIceCandidate(candidate) {
	console.log("Local candidate" + JSON.stringify(candidate));

	var message = {
		id : 'onIceCandidate',
		candidate : candidate
	};
	sendMessage(message);
}

function stop() {
	var message = {
		id : 'stop'
	}
	sendMessage(message);
	dispose();

	dump();
}

function dispose() {
	if (webRtcPeer) {
		webRtcPeer.dispose();
		webRtcPeer = null;
	}
	hideSpinner(video);

	isRemote = null;

	disableStopButton();
}

function disableStopButton() {
	enableButton('#presenter', 'presenter()');
	enableButton('#viewer', 'viewer()');
	disableButton('#stop');
}

function enableStopButton() {
	disableButton('#presenter');
	disableButton('#viewer');
	enableButton('#stop', 'stop()');
}

function disableButton(id) {
	$(id).attr('disabled', true);
	$(id).removeAttr('onclick');
}

function enableButton(id, functionName) {
	$(id).attr('disabled', false);
	$(id).attr('onclick', functionName);
}

function sendMessage(message) {
	var jsonMessage = JSON.stringify(message);
	console.log('Sending message: ' + jsonMessage);
	ws.send(jsonMessage);
}

function showSpinner() {
	for (var i = 0; i < arguments.length; i++) {
		arguments[i].poster = './img/transparent-1px.png';
		arguments[i].style.background = 'center transparent url("./img/spinner.gif") no-repeat';
	}
}

function hideSpinner() {
	for (var i = 0; i < arguments.length; i++) {
		arguments[i].src = '';
		arguments[i].poster = './img/webrtc.png';
		arguments[i].style.background = '';
	}
}

function dump() {
	console.log(jsonDump);
	if (jsonDump.length === 0) return;
	
	// download the stats file
	let now = new Date();
	const blob = new Blob([JSON.stringify(jsonDump, null, '  ')], {type: 'application/json'});
	const link = document.createElement('a');
	link.href = window.URL.createObjectURL(blob);
	link.download = 'webrtc_kurento_stats_' 
		+ now.getFullYear()
		+ now.getMonth()
		+ now.getDay()
		+ now.getHours()
		+ now.getMinutes()
		+ now.getSeconds()
		+ '.json';
	link.click();
  
	console.log("JSON data dumped");
}

/**
 * Lightbox utility (to display media pipeline image in a modal dialog)
 */
$(document).delegate('*[data-toggle="lightbox"]', 'click', function(event) {
	event.preventDefault();
	$(this).ekkoLightbox();
});
