(() => {
  const languages = [
    ['pt', 'Português'], ['en', 'Inglês'], ['es', 'Espanhol'], ['fr', 'Francês'],
    ['de', 'Alemão'], ['it', 'Italiano'], ['ja', 'Japonês'], ['ko', 'Coreano'], ['zh', 'Chinês'],
  ];
  let voices = [];
  let currentAudioUrl = null;
  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem('syncstore_usuario') || 'null'); } catch { return null; }
  })();

  function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') node.className = value;
      else if (key === 'style') node.style.cssText = value;
      else node.setAttribute(key, value);
    });
    if (text) node.textContent = text;
    return node;
  }

  async function jsonResponse(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.sucesso) throw new Error(data.mensagem || 'A solicitação falhou.');
    return data;
  }

  function voiceSelect() { return document.getElementById('voice-select'); }
  function voiceMessage(text, color = 'var(--muted)') {
    const node = document.getElementById('voice-message');
    if (node) { node.textContent = text; node.style.color = color; }
  }

  async function loadVoices() {
    const select = voiceSelect();
    if (!select) return;
    try {
      const query = currentUser?.id ? `?usuario_id=${encodeURIComponent(currentUser.id)}` : '';
      const data = await jsonResponse(await fetch(`/api/vozes${query}`));
      voices = data.vozes || [];
      const selected = select.value;
      select.innerHTML = '';
      select.appendChild(el('option', { value: '' }, 'Voz padrão (Chatterbox)'));
      voices.forEach((voice) => select.appendChild(el('option', { value: voice.id }, `${voice.nome} (${String(voice.idioma).toUpperCase()})`)));
      if (voices.some((voice) => String(voice.id) === selected)) select.value = selected;
      renderVoices();
    } catch (error) {
      voiceMessage(error.message, 'var(--danger)');
    }
  }

  function renderVoices() {
    const list = document.getElementById('voice-list');
    if (!list) return;
    list.replaceChildren();
    if (!voices.length) {
      list.appendChild(el('span', { style: 'color:var(--muted);font-size:.85rem' }, 'Nenhuma voz cadastrada ainda.'));
      return;
    }
    voices.forEach((voice) => {
      const row = el('div', { className: 'history-item' });
      const label = el('span', {}, `${voice.nome} • ${String(voice.idioma).toUpperCase()}`);
      const remove = el('button', { type: 'button', className: 'button button-danger', style: 'padding:8px 10px;font-size:.75rem' }, 'Excluir');
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Excluir a voz “${voice.nome}”?`)) return;
        try {
          await jsonResponse(await fetch('/api/vozes', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: voice.id, usuario_id: currentUser?.id }),
          }));
          await loadVoices();
          voiceMessage('Voz removida.', 'var(--success)');
        } catch (error) { voiceMessage(error.message, 'var(--danger)'); }
      });
      row.append(label, remove);
      list.appendChild(row);
    });
  }

  async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
  }

  function buildUI() {
    const adPanel = document.querySelector('.ad-panel');
    const adForm = document.getElementById('form-anuncio');
    if (!adPanel || !adForm || document.getElementById('voice-select')) return;

    const voiceField = el('label', { className: 'field' }, 'Voz do anúncio');
    const select = el('select', { id: 'voice-select', name: 'voz_id' });
    select.appendChild(el('option', { value: '' }, 'Voz padrão (Chatterbox)'));
    voiceField.appendChild(select);
    const voicePanel = el('section', { className: 'preview-box', style: 'margin-top:20px' });
    voicePanel.appendChild(el('h3', { style: 'margin:0 0 12px;font-family:Manrope' }, 'Minhas vozes'));
    const form = el('form', { id: 'voice-upload-form', style: 'display:grid;gap:12px' });
    const name = el('input', { name: 'nome', required: 'required', maxlength: '120', placeholder: 'Nome da voz, por exemplo: Locutora principal' });
    const languageLabel = el('label', { className: 'field' }, 'Idioma do áudio de referência');
    const language = el('select', { name: 'idioma' });
    languages.forEach(([code, label]) => language.appendChild(el('option', { value: code }, label)));
    languageLabel.appendChild(language);
    const fileLabel = el('label', { className: 'field' }, 'Áudio de referência (até 3 MB)');
    const file = el('input', { type: 'file', name: 'audio', accept: 'audio/*', required: 'required' });
    fileLabel.appendChild(file);
    const submit = el('button', { type: 'submit', className: 'button button-primary' }, 'Adicionar voz');
    const message = el('p', { id: 'voice-message', className: 'form-message', role: 'status' });
    const list = el('div', { id: 'voice-list', style: 'display:grid;gap:8px;margin-top:12px' });
    form.append(name, languageLabel, fileLabel, submit, message);
    voicePanel.append(form, list);
    adForm.insertBefore(voiceField, adForm.querySelector('.ad-actions'));
    adPanel.insertAdjacentElement('afterend', voicePanel);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!file.files?.[0]) return;
      if (file.files[0].size > 3 * 1024 * 1024) {
        voiceMessage('O arquivo deve ter no máximo 3 MB.', 'var(--danger)');
        return;
      }
      submit.disabled = true;
      voiceMessage('Enviando voz...');
      try {
        await jsonResponse(await fetch('/api/vozes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome: name.value.trim(), idioma: language.value, audio_mime: file.files[0].type || 'audio/wav',
            audio_base64: await fileToBase64(file.files[0]), usuario_id: currentUser?.id,
          }),
        }));
        form.reset();
        await loadVoices();
        voiceMessage('Voz adicionada. Escolha-a no campo “Voz do anúncio”.', 'var(--success)');
      } catch (error) { voiceMessage(error.message, 'var(--danger)'); }
      finally { submit.disabled = false; }
    });
    loadVoices();
  }

  async function generateAndPlay(text, voiceId, language) {
    voiceMessage('Gerando áudio com Chatterbox…');
    const response = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: text, voz_id: voiceId || null, idioma: language || 'pt', usuario_id: currentUser?.id }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.mensagem || 'Não foi possível gerar áudio.');
    }
    const blob = await response.blob();
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = URL.createObjectURL(blob);
    const audio = new Audio(currentAudioUrl);
    await audio.play();
    voiceMessage('Áudio do Chatterbox reproduzindo.', 'var(--success)');
  }

  document.addEventListener('click', async (event) => {
    const playButton = event.target.closest('#btn-gerar-audio');
    const saveButton = event.target.closest('#btn-salvar-anuncio');
    if (!playButton && !saveButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (playButton) {
      const text = document.getElementById('input-texto-anuncio')?.value.trim();
      if (!text) { voiceMessage('Gere ou escreva um anúncio primeiro.', 'var(--danger)'); return; }
      try {
        const selected = voices.find((voice) => String(voice.id) === voiceSelect()?.value);
        await generateAndPlay(text, selected?.id || null, selected?.idioma || 'pt');
      } catch (error) { voiceMessage(error.message, 'var(--danger)'); }
      return;
    }

    const product = document.getElementById('input-produto')?.value.trim();
    const text = document.getElementById('input-texto-anuncio')?.value.trim();
    const voiceId = voiceSelect()?.value || null;
    if (!product || !text) { voiceMessage('Preencha o produto e o texto antes de salvar.', 'var(--danger)'); return; }
    try {
      await jsonResponse(await fetch('/api/anuncios', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ produto: product, texto: text, usuario_id: currentUser?.id, voz_id: voiceId }),
      }));
      voiceMessage('Anúncio salvo com a voz selecionada.', 'var(--success)');
      document.dispatchEvent(new CustomEvent('syncstore:refresh-history'));
    } catch (error) { voiceMessage(error.message, 'var(--danger)'); }
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else buildUI();
})();
