/**
 * On-Tour Admin Studio Controller
 */

let socket = null;
let roomCode = null;
let rtcManager = null;
let localStream = null;
let fileStream = null;
let isBroadcastingFile = false;

let isMicMuted = false;
let isCamOff = false;

window.addEventListener('DOMContentLoaded', async () => {
  // Password check removed for testing - auto authorized

  const iceRes = await fetch('/api/ice-servers');
  const { iceServers } = await iceRes.json();

  await initWebcam();

  socket = io();

  rtcManager = new PeerConnectionManager({
    iceServers,
    onRemoteStream: (senderSocketId, stream, track) => {
      handleRemoteClientStream(senderSocketId, stream);
    },
    onRemoteTrackEnd: (senderSocketId, track) => {
      removeClientTile(senderSocketId);
    },
    onIceCandidate: (targetSocketId, candidate) => {
      socket.emit('webrtc-ice-candidate', { targetSocketId, candidate });
    },
    onConnectionStateChange: (targetSocketId, state) => {
      const tile = document.getElementById(`client-tile-${targetSocketId}`);
      if (tile) {
        const badge = tile.querySelector('.status-indicator');
        if (badge) badge.textContent = state;
      }
      if (state === 'failed' || state === 'disconnected') {
        removeClientTile(targetSocketId);
      }
    }
  });

  socket.emit('create-room', (res) => {
    if (res.success) {
      roomCode = res.roomCode;
      document.getElementById('activeRoomCodeLabel').textContent = `Room: ${roomCode}`;
    } else {
      alert("Failed to initialize tour room: " + res.error);
    }
  });

  socket.on('participant-joined', async ({ socketId, displayName }) => {
    appendChat({ sender: 'System', role: 'system', text: `${displayName} joined the tour.`, time: '' });
    updateClientCount();
    
    const activeStream = isBroadcastingFile ? fileStream : localStream;
    rtcManager.createPeerConnection(socketId, activeStream, true, (targetId, sdp) => {
      socket.emit('webrtc-offer', { targetSocketId: targetId, sdp });
    });
  });

  socket.on('webrtc-answer', async ({ senderSocketId, sdp }) => {
    await rtcManager.handleRemoteAnswer(senderSocketId, sdp);
  });

  socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
    await rtcManager.addIceCandidate(senderSocketId, candidate);
  });

  socket.on('participant-left', ({ socketId, displayName }) => {
    appendChat({ sender: 'System', role: 'system', text: `${displayName} left the tour.`, time: '' });
    rtcManager.closePeerConnection(socketId);
    removeClientTile(socketId);
    updateClientCount();
  });

  socket.on('chat-broadcast', (msg) => {
    appendChat(msg);
  });

  socket.on('participant-media-state', ({ socketId, videoEnabled, audioEnabled }) => {
    const tile = document.getElementById(`client-tile-${socketId}`);
    if (tile) {
      const label = tile.querySelector('.client-tile-tag');
      if (label) {
        label.textContent = `${label.dataset.name} ${!videoEnabled ? '[Cam Off]' : ''} ${!audioEnabled ? '[Muted]' : ''}`;
      }
    }
  });
});

async function initWebcam() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    document.getElementById('broadcastVideoPreview').srcObject = localStream;
    document.getElementById('adminSelfCam').srcObject = localStream;
    document.getElementById('viewportStatusOverlay').style.display = 'none';
  } catch (err) {
    console.error("Camera access error:", err);
    document.getElementById('viewportStatusOverlay').textContent = "Camera access denied or unavailable.";
  }
}

function handleRemoteClientStream(socketId, stream) {
  let tile = document.getElementById(`client-tile-${socketId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'client-tile';
    tile.id = `client-tile-${socketId}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false; // Admin listens to clients
    video.srcObject = stream;

    const tag = document.createElement('div');
    tag.className = 'client-tile-tag';
    tag.dataset.name = `Client ${socketId.substr(0, 4)}`;
    tag.textContent = tag.dataset.name;

    const status = document.createElement('span');
    status.className = 'status-indicator';
    status.style.marginLeft = '5px';
    status.style.color = 'var(--color-success)';
    tag.appendChild(status);

    tile.appendChild(video);
    tile.appendChild(tag);
    document.getElementById('clientVideoGrid').appendChild(tile);
  } else {
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }
  updateClientCount();
}

function removeClientTile(socketId) {
  const tile = document.getElementById(`client-tile-${socketId}`);
  if (tile) tile.remove();
  updateClientCount();
}

function updateClientCount() {
  const count = document.getElementById('clientVideoGrid').children.length;
  document.getElementById('clientCountLabel').textContent = count;
}

function toggleAdminMic() {
  if (!localStream) return;
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
  document.getElementById('toggleMicBtn').textContent = isMicMuted ? "Unmute Mic" : "Mute Mic";
  socket.emit('media-state-change', { videoEnabled: !isCamOff, audioEnabled: !isMicMuted });
}

function toggleAdminCam() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  document.getElementById('toggleCamBtn').textContent = isCamOff ? "Start Cam" : "Stop Cam";
  socket.emit('media-state-change', { videoEnabled: !isCamOff, audioEnabled: !isMicMuted });
}

async function handleFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  const filePlayer = document.getElementById('filePlaybackElement');
  filePlayer.src = URL.createObjectURL(file);
  await filePlayer.play();

  let stream;
  if (filePlayer.captureStream) {
    stream = filePlayer.captureStream();
  } else if (filePlayer.mozCaptureStream) {
    stream = filePlayer.mozCaptureStream();
  } else {
    alert("Browser does not support direct video element stream capture.");
    return;
  }

  fileStream = stream;
  isBroadcastingFile = true;

  document.getElementById('broadcastVideoPreview').srcObject = fileStream;
  document.getElementById('returnWebcamBtn').style.display = 'inline-block';

  rtcManager.replaceSenderTracks(fileStream);
}

function returnToWebcam() {
  if (!localStream) return;
  const filePlayer = document.getElementById('filePlaybackElement');
  filePlayer.pause();
  filePlayer.src = "";
  fileStream = null;
  isBroadcastingFile = false;

  document.getElementById('broadcastVideoPreview').srcObject = localStream;
  document.getElementById('returnWebcamBtn').style.display = 'none';

  rtcManager.replaceSenderTracks(localStream);
}

function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const msg = input.value;
  if (!msg.trim()) return;

  socket.emit('send-chat', { message: msg });
  input.value = '';
}

function appendChat(msg) {
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

function copyInviteLink() {
  if (!roomCode) return;
  const url = `${window.location.origin}/?room=${roomCode}`;
  navigator.clipboard.writeText(url).then(() => alert("Tour invite link copied to clipboard!"));
}

function toggleFullscreen() {
  const vp = document.getElementById('viewportContainer');
  if (!document.fullscreenElement) {
    vp.requestFullscreen().catch(err => alert(err.message));
  } else {
    document.exitFullscreen();
  }
}

async function endTourRoom() {
  if (confirm("End presentation and close this room for all attendees?")) {
    socket.emit('end-room');
    if (rtcManager) rtcManager.closeAll();
    window.location.reload();
  }
}

async function logoutAdmin() {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin';
}
