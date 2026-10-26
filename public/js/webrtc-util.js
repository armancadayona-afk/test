/**
 * On-Tour WebRTC Peer Connection & Media Helper
 */
class PeerConnectionManager {
  constructor({ iceServers, onRemoteStream, onRemoteTrackEnd, onIceCandidate, onConnectionStateChange }) {
    this.iceServers = iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    this.onRemoteStream = onRemoteStream;
    this.onRemoteTrackEnd = onRemoteTrackEnd;
    this.onIceCandidate = onIceCandidate;
    this.onConnectionStateChange = onConnectionStateChange;

    this.peerConnections = new Map(); // socketId -> RTCPeerConnection
    this.iceCandidatesQueue = new Map(); // socketId -> RTCIceCandidate[]
  }

  createPeerConnection(targetSocketId, localStream, isInitiator, sendOfferCallback) {
    if (this.peerConnections.has(targetSocketId)) {
      this.closePeerConnection(targetSocketId);
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    this.peerConnections.set(targetSocketId, pc);
    this.iceCandidatesQueue.set(targetSocketId, []);

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(targetSocketId, event.candidate);
      }
    };

    pc.ontrack = (event) => {
      if (this.onRemoteStream) {
        const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
        this.onRemoteStream(targetSocketId, stream, event.track);
      }

      event.track.onended = () => {
        if (this.onRemoteTrackEnd) {
          this.onRemoteTrackEnd(targetSocketId, event.track);
        }
      };
    };

    pc.onconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(targetSocketId, pc.connectionState);
      }
    };

    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendOfferCallback(targetSocketId, pc.localDescription);
        } catch (err) {
          console.error(`[WebRTC] Failed to create offer for ${targetSocketId}:`, err);
        }
      };
    }

    return pc;
  }

  async handleRemoteOffer(targetSocketId, sdp, localStream, sendAnswerCallback) {
    let pc = this.peerConnections.get(targetSocketId);
    if (!pc) {
      pc = this.createPeerConnection(targetSocketId, localStream, false);
    }

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this.processQueuedCandidates(targetSocketId);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendAnswerCallback(targetSocketId, pc.localDescription);
  }

  async handleRemoteAnswer(targetSocketId, sdp) {
    const pc = this.peerConnections.get(targetSocketId);
    if (!pc) return;

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this.processQueuedCandidates(targetSocketId);
  }

  async addIceCandidate(targetSocketId, candidate) {
    const pc = this.peerConnections.get(targetSocketId);
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      const queue = this.iceCandidatesQueue.get(targetSocketId) || [];
      queue.push(candidate);
      this.iceCandidatesQueue.set(targetSocketId, queue);
    }
  }

  async processQueuedCandidates(targetSocketId) {
    const pc = this.peerConnections.get(targetSocketId);
    const queue = this.iceCandidatesQueue.get(targetSocketId) || [];
    if (!pc) return;

    while (queue.length > 0) {
      const candidate = queue.shift();
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn(`[WebRTC] Failed to add queued ICE candidate:`, err);
      }
    }
  }

  replaceSenderTracks(newStream) {
    const newVideoTrack = newStream.getVideoTracks()[0] || null;
    const newAudioTrack = newStream.getAudioTracks()[0] || null;

    this.peerConnections.forEach((pc) => {
      const senders = pc.getSenders();

      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender && newVideoTrack) {
        videoSender.replaceTrack(newVideoTrack).catch(e => console.error("Video replaceTrack error:", e));
      }

      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender && newAudioTrack) {
        audioSender.replaceTrack(newAudioTrack).catch(e => console.error("Audio replaceTrack error:", e));
      }
    });
  }

  closePeerConnection(targetSocketId) {
    const pc = this.peerConnections.get(targetSocketId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
      this.peerConnections.delete(targetSocketId);
    }
    this.iceCandidatesQueue.delete(targetSocketId);
  }

  closeAll() {
    this.peerConnections.forEach((pc, id) => this.closePeerConnection(id));
  }
}

window.PeerConnectionManager = PeerConnectionManager;
