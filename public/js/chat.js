(() => {
  const nickname = sessionStorage.getItem('chtkeey_nickname');
  if (!nickname) {
    window.location.href = '/';
    return;
  }

  const socket = io({ query: { nickname } });

  const searchingView = document.getElementById('searching-view');
  const chatView = document.getElementById('chat-view');
  const chatBody = document.getElementById('chat-body');
  const partnerStatus = document.getElementById('partner-status');
  const msgInput = document.getElementById('msg-input');
  const reportModal = document.getElementById('report-modal');
  let typingTimeout = null;

  function addMessage(text, kind) {
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    div.textContent = text;
    chatBody.appendChild(div);
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  function showSearching() {
    searchingView.classList.remove('hidden');
    chatView.style.display = 'none';
    partnerStatus.textContent = 'searching…';
    chatBody.innerHTML = '';
  }

  function showChat(partnerNickname) {
    searchingView.classList.add('hidden');
    chatView.style.display = 'contents';
    partnerStatus.textContent = `chatting with ${partnerNickname}`;
    addMessage(`You're connected with ${partnerNickname}. Say silav 👋`, 'system');
  }

  socket.on('connect', () => {
    socket.emit('find-partner');
  });

  socket.on('searching', showSearching);

  socket.on('matched', ({ partnerNickname }) => showChat(partnerNickname));

  socket.on('chat-message', ({ text, from }) => {
    addMessage(text, from === 'me' ? 'me' : 'stranger');
  });

  socket.on('typing', (isTyping) => {
    partnerStatus.textContent = isTyping ? 'stranger is typing…' : 'chatting';
  });

  socket.on('partner-left', ({ reason }) => {
    const messages = {
      left: 'Stranger left the chat.',
      disconnected: 'Stranger disconnected.',
      reported: 'Stranger left the chat.',
      requeued: 'Stranger left to talk to someone else.'
    };
    addMessage(messages[reason] || 'Stranger left the chat.', 'system');
    partnerStatus.textContent = 'not connected';
    setTimeout(() => socket.emit('find-partner'), 900);
  });

  socket.on('report-received', () => {
    addMessage('Thanks — your report was sent to moderation.', 'system');
  });

  socket.on('banned', () => {
    alert('You have been removed from Chtkeey due to multiple reports.');
    sessionStorage.removeItem('chtkeey_nickname');
    window.location.href = '/';
  });

  document.getElementById('btn-cancel-search').addEventListener('click', () => {
    sessionStorage.removeItem('chtkeey_nickname');
    window.location.href = '/';
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    socket.emit('find-partner');
  });

  document.getElementById('btn-report').addEventListener('click', () => {
    reportModal.classList.remove('hidden');
  });
  document.getElementById('btn-cancel-report').addEventListener('click', () => {
    reportModal.classList.add('hidden');
  });
  document.getElementById('btn-submit-report').addEventListener('click', () => {
    const checked = document.querySelector('input[name="reason"]:checked');
    socket.emit('report', { reason: checked ? checked.value : 'unspecified' });
    reportModal.classList.add('hidden');
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && msgInput.value.trim()) {
      socket.emit('chat-message', msgInput.value.trim());
      msgInput.value = '';
      socket.emit('typing', false);
    } else {
      socket.emit('typing', true);
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => socket.emit('typing', false), 1200);
    }
  });
})();
