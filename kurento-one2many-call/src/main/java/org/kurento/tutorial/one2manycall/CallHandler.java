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

package org.kurento.tutorial.one2manycall;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

// import org.kurento.client.BaseRtpEndpoint;
import org.kurento.client.EndpointStats;
import org.kurento.client.EventListener;
import org.kurento.client.IceCandidate;
import org.kurento.client.IceCandidateFoundEvent;
import org.kurento.client.KurentoClient;
import org.kurento.client.MediaPipeline;
import org.kurento.client.MediaState;
import org.kurento.client.MediaStateChangedEvent;
import org.kurento.client.MediaType;
import org.kurento.client.Stats;
import org.kurento.client.StatsType;
import org.kurento.client.WebRtcEndpoint;
import org.kurento.jsonrpc.JsonUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;

/**
 * Protocol handler for 1 to N video call communication.
 *
 * @author Boni Garcia (bgarcia@gsyc.es)
 * @since 5.0.0
 */
public class CallHandler extends TextWebSocketHandler {

  private static final Logger log = LoggerFactory.getLogger(CallHandler.class);
  private static final Gson gson = new GsonBuilder().create();

  private ConcurrentHashMap<String, UserSession> viewers = new ConcurrentHashMap<>();

  private ConcurrentHashMap<String, ConcurrentLinkedQueue<Long>> presenterTimestamps = new ConcurrentHashMap<>();

  @Autowired
  private KurentoClient kurento;

  private MediaPipeline pipeline;
  private UserSession presenterUserSession;
  // private UserSession viewerUserSession;

  // mixBandwidth affects the MinVideoBandwidth.
  // Unit: kbps
  // Default: 100
  // 0 means no limit
  private static Integer minBandwidth = 0;
  // maxBandwidth affects the MaxVideoBandwidth.
  // Unit: kbps
  // Default: 500
  // 0 means no limit
  private static Integer maxBandwidth = 0;
  // number of viewers
  private static Integer numViewers = 2;

  @Override
  public void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
    JsonObject jsonMessage = gson.fromJson(message.getPayload(), JsonObject.class);
    log.debug("Incoming message from session '{}': {}", session.getId(), jsonMessage);

    switch (jsonMessage.get("id").getAsString()) {
      case "presenter":
        try {
          presenter(session, jsonMessage);
        } catch (Throwable t) {
          handleErrorResponse(t, session, "presenterResponse");
        }
        break;
      case "viewer":
        try {
          viewer(session, jsonMessage);
        } catch (Throwable t) {
          handleErrorResponse(t, session, "viewerResponse");
        }
        break;
      case "onIceCandidate": {
        JsonObject candidate = jsonMessage.get("candidate").getAsJsonObject();

        UserSession user = null;
        if (presenterUserSession != null) {
          if (presenterUserSession.getSession() == session) {
            user = presenterUserSession;
          } else {
            user = viewers.get(session.getId());
          }
        }
        if (user != null) {
          IceCandidate cand =
              new IceCandidate(candidate.get("candidate").getAsString(), candidate.get("sdpMid")
                  .getAsString(), candidate.get("sdpMLineIndex").getAsInt());
          user.addCandidate(cand);
        }
        break;
      }
      case "getLatencyStats": {
        try {
          sendLatencyStats(session, jsonMessage);
        } catch (Throwable t) {
          handleErrorResponse(t, session, "getLatencyStatsResponse");
        }
        break;
      }
      case "stop":
        stop(session);
        break;
      default:
        break;
    }
  }

  private void handleErrorResponse(Throwable throwable, WebSocketSession session, String responseId)
      throws IOException {
    stop(session);
    log.error(throwable.getMessage(), throwable);
    JsonObject response = new JsonObject();
    response.addProperty("id", responseId);
    response.addProperty("response", "rejected");
    response.addProperty("message", throwable.getMessage());
    session.sendMessage(new TextMessage(response.toString()));
  }

  private synchronized void presenter(final WebSocketSession session, JsonObject jsonMessage)
      throws IOException {
    if (presenterUserSession == null) {
      presenterUserSession = new UserSession(session);

      pipeline = kurento.createMediaPipeline();

      // Activate the ability to gather end-to-end latency stats
      try {
        pipeline.setLatencyStats(true);
      } catch (Exception e) {
        log.error("Error setting latency stats: {}", e.getMessage());
      }

      presenterUserSession.setWebRtcEndpoint(new WebRtcEndpoint.Builder(pipeline).build());

      WebRtcEndpoint presenterWebRtc = presenterUserSession.getWebRtcEndpoint();

      // Bandwidth settings
      presenterWebRtc.setMinVideoRecvBandwidth(minBandwidth);
      presenterWebRtc.setMaxAudioRecvBandwidth(maxBandwidth);
      presenterWebRtc.setMaxVideoRecvBandwidth(maxBandwidth);
      // presenterWebRtc.setMinVideoSendBandwidth(minBandwidth);
      // presenterWebRtc.setMaxVideoSendBandwidth(maxBandwidth);
      // presenterWebRtc.setMinOutputBitrate(minBandwidth);
      presenterWebRtc.setMaxOutputBitrate(maxBandwidth);

      presenterWebRtc.addIceCandidateFoundListener(new EventListener<IceCandidateFoundEvent>() {

        @Override
        public void onEvent(IceCandidateFoundEvent event) {
          JsonObject response = new JsonObject();
          response.addProperty("id", "iceCandidate");
          response.add("candidate", JsonUtils.toJsonObject(event.getCandidate()));
          try {
            synchronized (session) {
              session.sendMessage(new TextMessage(response.toString()));
            }
          } catch (IOException e) {
            log.debug(e.getMessage());
          }
        }
      });

      presenterWebRtc.addMediaStateChangedListener(new EventListener<MediaStateChangedEvent>() {

        @Override
        public void onEvent(MediaStateChangedEvent event) {
          if (event.getNewState() == MediaState.CONNECTED) {
            JsonObject response = new JsonObject();
            response.addProperty("id", "mediaStateChanged");
            try {
              synchronized (session) {
                session.sendMessage(new TextMessage(response.toString()));
              }
            } catch (IOException e) {
              log.debug(e.getMessage());
            }
          }
        }
      });

      String sdpOffer = jsonMessage.getAsJsonPrimitive("sdpOffer").getAsString();
      String sdpAnswer = presenterWebRtc.processOffer(sdpOffer);

      JsonObject response = new JsonObject();
      response.addProperty("id", "presenterResponse");
      response.addProperty("response", "accepted");
      response.addProperty("sdpAnswer", sdpAnswer);

      synchronized (session) {
        presenterUserSession.sendMessage(response);
      }

      presenterWebRtc.gatherCandidates();
    } else {
      JsonObject response = new JsonObject();
      response.addProperty("id", "presenterResponse");
      response.addProperty("response", "rejected");
      response.addProperty("message",
          "Another user is currently acting as sender. Try again later ...");
      session.sendMessage(new TextMessage(response.toString()));
    }
  }

  private synchronized void viewer(final WebSocketSession session, JsonObject jsonMessage)
      throws IOException {
    if (presenterUserSession == null || presenterUserSession.getWebRtcEndpoint() == null) {
      JsonObject response = new JsonObject();
      response.addProperty("id", "viewerResponse");
      response.addProperty("response", "rejected");
      response.addProperty("message",
          "No active sender now. Become sender or . Try again later ...");
      session.sendMessage(new TextMessage(response.toString()));
    } else {
      if (viewers.containsKey(session.getId())) {
        JsonObject response = new JsonObject();
        response.addProperty("id", "viewerResponse");
        response.addProperty("response", "rejected");
        response.addProperty("message", "You are already viewing in this session. "
            + "Use a different browser to add additional viewers.");
        session.sendMessage(new TextMessage(response.toString()));
        return;
      }
      UserSession viewerUserSession = new UserSession(session);
      viewers.put(session.getId(), viewerUserSession);          presenterTimestamps.put(session.getId(), new ConcurrentLinkedQueue<Long>());

      WebRtcEndpoint nextWebRtc = new WebRtcEndpoint.Builder(pipeline).build();

      // Bandwidth settings
      // nextWebRtc.setMinVideoRecvBandwidth(minBandwidth);
      // nextWebRtc.setMaxAudioRecvBandwidth(minBandwidth);
      // nextWebRtc.setMaxVideoRecvBandwidth(maxBandwidth);
      nextWebRtc.setMinVideoSendBandwidth(minBandwidth);
      nextWebRtc.setMaxVideoSendBandwidth(maxBandwidth);
      // nextWebRtc.setMinOutputBitrate(minBandwidth);
      nextWebRtc.setMaxOutputBitrate(maxBandwidth);

      nextWebRtc.addIceCandidateFoundListener(new EventListener<IceCandidateFoundEvent>() {

        @Override
        public void onEvent(IceCandidateFoundEvent event) {
          JsonObject response = new JsonObject();
          response.addProperty("id", "iceCandidate");
          response.add("candidate", JsonUtils.toJsonObject(event.getCandidate()));
          try {
            synchronized (session) {
              session.sendMessage(new TextMessage(response.toString()));
            }
          } catch (IOException e) {
            log.debug(e.getMessage());
          }
        }
      });

      nextWebRtc.addMediaStateChangedListener(new EventListener<MediaStateChangedEvent>() {

        @Override
        public void onEvent(MediaStateChangedEvent event) {
          if (event.getNewState() == MediaState.CONNECTED) {
            JsonObject response = new JsonObject();
            response.addProperty("id", "mediaStateChanged");
            try {
              synchronized (session) {
                session.sendMessage(new TextMessage(response.toString()));
              }
            } catch (IOException e) {
              log.debug(e.getMessage());
            }
          }
        }
      });

      viewerUserSession.setWebRtcEndpoint(nextWebRtc);
      presenterUserSession.getWebRtcEndpoint().connect(nextWebRtc);

      String sdpOffer = jsonMessage.getAsJsonPrimitive("sdpOffer").getAsString();
      String sdpAnswer = nextWebRtc.processOffer(sdpOffer);

      JsonObject response = new JsonObject();
      response.addProperty("id", "viewerResponse");
      response.addProperty("response", "accepted");
      response.addProperty("sdpAnswer", sdpAnswer);

      synchronized (session) {
        viewerUserSession.sendMessage(response);
      }

      if (viewers.size() == numViewers) {
        // Start stats' collection
        for (UserSession viewer : viewers.values()) {
          viewer.getWebRtcEndpoint().gatherCandidates();
          activateStatsTimeout(viewer);
        }
        
        activateStatsTimeout(presenterUserSession);
      }
      // nextWebRtc.gatherCandidates();
    }
  }

  private synchronized void stop(WebSocketSession session) throws IOException {
    String sessionId = session.getId();
    if (presenterUserSession != null && presenterUserSession.getSession().getId().equals(sessionId)) {
      for (UserSession viewer : viewers.values()) {
        JsonObject response = new JsonObject();
        response.addProperty("id", "stopCommunication");
        viewer.sendMessage(response);
      }

      log.info("Releasing media pipeline");
      if (pipeline != null) {
        pipeline.release();
      }
      pipeline = null;
      presenterUserSession = null;
      presenterTimestamps.remove(sessionId);
    } else if (viewers.containsKey(sessionId)) {
      if (viewers.get(sessionId).getWebRtcEndpoint() != null) {
        viewers.get(sessionId).getWebRtcEndpoint().release();
      }
      viewers.remove(sessionId);
    }
  }

  private synchronized void activateStatsTimeout(UserSession session) {
    if (session == null) {
      log.warn("The session is null");
      return;
    }

    try {
      JsonObject response = new JsonObject();
      response.addProperty("id", "activateStatsTimeout");
      synchronized (session) {
        session.sendMessage(response);
      }
    } catch (IOException e) {
      log.debug(e.getMessage());
    } catch (Exception e) {
      log.warn("Stats timeout could not be activated: ", e);
      return;
    }
  }

  private synchronized void sendLatencyStats(final WebSocketSession session, JsonObject jsonMessage) 
      throws IOException {
    if (jsonMessage.has("isPresenter")) {
      assert jsonMessage.get("isPresenter").getAsBoolean() == true;
      if (session == presenterUserSession.getSession()) {
        presenterTimestamps.forEach((key, queue) -> {
          queue.offer(jsonMessage.get("timestamp").getAsLong());
        });
      } else {
        log.warn("The session is not the presenter");
      }
      return;
    }

    JsonObject response = new JsonObject();
    response.addProperty("id", "latencyStatsResponse");
    response.addProperty("sendTime", jsonMessage.get("timestamp").getAsLong());

    // log.info("Received getLatencyStats : {} at {}", jsonMessage.get("timestamp").getAsLong(), System.currentTimeMillis());

    JsonObject stats = new JsonObject();

    Map<String, Stats> audioStatsMap = viewers.get(session.getId()).getWebRtcEndpoint().getStats(MediaType.AUDIO);
    JsonObject audioStats = new JsonObject();
    audioStatsMap.forEach((key, value) -> {
      // look for the type we want
      if (value.getType() != StatsType.endpoint) return;

      // data log
      EndpointStats endpointStats = (EndpointStats) value;
      audioStats.addProperty("timestampMillis", value.getTimestampMillis());
      audioStats.addProperty("inputLatency", endpointStats.getInputAudioLatency());
      audioStats.addProperty("E2ELatency", endpointStats.getAudioE2ELatency());

      // log.info("AUDIO: {}", audioStats);
    });

    Map<String, Stats> videoStatsMap = viewers.get(session.getId()).getWebRtcEndpoint().getStats(MediaType.VIDEO);
    JsonObject videoStats = new JsonObject();
    videoStatsMap.forEach((key, value) -> {
      // look for the type we want
      if (value.getType() != StatsType.endpoint) return;

      // data log
      EndpointStats endpointStats = (EndpointStats) value;
      videoStats.addProperty("timestampMillis", value.getTimestampMillis());
      videoStats.addProperty("inputLatency", endpointStats.getInputVideoLatency());
      videoStats.addProperty("E2ELatency", endpointStats.getVideoE2ELatency());

      // log.info("VIDEO: {}", videoStats);
    });
    
    stats.add("audio", audioStats);
    stats.add("video", videoStats);
    response.addProperty("response", "accepted");
    response.add("data", stats);

    synchronized (session) {
      session.sendMessage(new TextMessage(response.toString()));
    }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
    stop(session);
  }

}
