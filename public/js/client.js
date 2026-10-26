/**
 * On-Tour Client Room Controller
 */

let socket = null;
let roomCode = null;
let displayName = null;
let rtcManager = null;
let localStream = null;

let isMicMuted = false;
let isCamOff = false;

window.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  roomCode = params.get('room');
  displayName = params.get('name');

  if (!roomCode || !displayName) {
    alert("Invalid tour access link. Missing room code or participant name.");
    window.location.href = '/';
    return;
  }

  const iceRes = await fetch('/api/ice-servers');
  const { iceServers } = await iceRes.json();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true
    });
    document.getElementById('clientSelfPreview').srcObject = localStream;
  } catch (err) {
    console.warn("Client device access denied or limited:", err);
    alert("Camera/microphone access is required so the tour guide can see and hear you.");
  }

  socket = io();

  rtcManager = new PeerConnectionManager({
    iceServers,
    onRemoteStream: (senderSocketId, stream, track) => {
      const adminVideo = document.getElementById('adminPresentationFeed');
      adminVideo.srcObject = stream;
      document.getElementById('presentationOverlay').style.display = 'none';
    },
    onRemoteTrackEnd: () => {
      document.getElementById('presentationOverlay').style.display = 'block';
      document.getElementById('presentationOverlay').textContent = "Tour guide presentation has ended.";
    },
    onIceCandidate: (targetSocketId, candidate) => {
      socket.emit('webrtc-ice-candidate', { targetSocketId, candidate });
    },
    onConnectionStateChange: (targetSocketId, state) => {
      const badge = document.getElementById('clientStatusBadge');
      badge.textContent = state === 'connected' ? 'Live Connected' : state;
      badge.style.color = state === 'connected' ? 'var(--color-success)' : 'var(--color-danger)';
    }
  });

  socket.emit('join-room', { roomCode, displayName }, (res) => {
    if (!res.success) {
      alert("Error joining tour: " + res.error);
      window.location.href = '/';
      return;
    }

    document.getElementById('clientStatusBadge').textContent = 'Connected';

    if (res.chatHistory) {
      res.chatHistory.forEach(appendClientChat);
    }
  });

  socket.on('webrtc-offer', async ({ senderSocketId, sdp }) => {
    await rtcManager.handleRemoteOffer(senderSocketId, sdp, localStream, (targetId, answerSdp) => {
      socket.emit('webrtc-answer', { targetSocketId: targetId, sdp: answerSdp });
    });
  });

  socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
    await rtcManager.addIceCandidate(senderSocketId, candidate);
  });

  socket.on('chat-broadcast', (msg) => {
    appendClientChat(msg);
  });

  socket.on('admin-disconnected', () => {
    document.getElementById('presentationOverlay').style.display = 'block';
    document.getElementById('presentationOverlay').textContent = "Tour guide lost connection. Please wait...";
  });

  socket.on('room-closed', () => {
    alert("The tour guide has ended the presentation.");
    leaveCall();
  });
});

function toggleClientMic() {
  if (!localStream) return;
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
  document.getElementById('toggleMicBtn').textContent = isMicMuted ? "Unmute Mic" : "Mute Mic";
  socket.emit('media-state-change', { videoEnabled: !isCamOff, audioEnabled: !isMicMuted });
}

function toggleClientCam() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  document.getElementById('toggleCamBtn').textContent = isCamOff ? "Start Cam" : "Stop Cam";
  socket.emit('media-state-change', { videoEnabled: !isCamOff, audioEnabled: !isMicMuted });
}

function sendClientChat(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const msg = input.value;
  if (!msg.trim()) return;

  socket.emit('send-chat', { message: msg });
  input.value = '';
}

function appendClientChat(msg) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-bubble';
  div.innerHTML = `<div class="meta">${escapeHtml(msg.sender)} &bull; ${msg.time}</div><div>${escapeHtml(msg.text)}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function leaveCall() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  if (rtcManager) {
    rtcManager.closeAll();
  }
  window.location.href = '/';
}
