(function() {
  'use strict';

  const state = {
    isLoading: false,
    videoFetched: false,
    selectedFormat: 'mp4',
    selectedQuality: null,
    selectedQualityLabel: '',
    videoData: null,
    currentUrl: ''
  };

  const elements = {
    videoForm: document.getElementById('videoForm'),
    videoUrl: document.getElementById('videoUrl'),
    pasteBtn: document.getElementById('pasteBtn'),
    getVideoBtn: document.getElementById('getVideoBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    errorMessage: document.getElementById('errorMessage'),
    resultSection: document.getElementById('resultSection'),
    thumbnail: document.getElementById('thumbnail'),
    videoTitle: document.getElementById('videoTitle'),
    videoUploader: document.getElementById('videoUploader'),
    qualitySection: document.getElementById('qualitySection'),
    qualityOptions: document.getElementById('qualityOptions')
  };

  function showError(message) {
    elements.errorMessage.innerHTML = `
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
      </svg>
      <span>${message}</span>
    `;
    elements.errorMessage.classList.remove('hidden');
  }

  function hideError() {
    elements.errorMessage.classList.add('hidden');
  }

  function showElement(element) {
    element.classList.remove('hidden');
  }

  function hideElement(element) {
    element.classList.add('hidden');
  }

  function setButtonLoading(button, loading) {
    const btnText = button.querySelector('.btn-text');
    if (loading) {
      button.classList.add('loading');
      button.disabled = true;
      if (btnText) btnText.textContent = 'Loading...';
    } else {
      button.classList.remove('loading');
      button.disabled = false;
      if (btnText) {
        const isDownload = button.id === 'downloadBtn';
        btnText.textContent = isDownload ? 'Download' : 'Get Video';
      }
    }
  }

  function resetUI(fullReset = false) {
    state.videoFetched = false;
    state.selectedQuality = null;
    state.selectedQualityLabel = '';
    state.videoData = null;
    state.currentUrl = '';
    
    hideElement(elements.resultSection);
    hideError();
    
    elements.downloadBtn.disabled = true;
    elements.downloadBtn.classList.remove('loading');
    
    elements.qualityOptions.innerHTML = '';
  }

  function resetForNewFetch() {
    state.videoFetched = false;
    state.selectedQuality = null;
    state.selectedQualityLabel = '';
    state.videoData = null;
    
    hideElement(elements.resultSection);
    hideError();
    
    elements.downloadBtn.disabled = true;
    elements.qualityOptions.innerHTML = '';
  }

  function validateUrl(url) {
    const youtubePatterns = [
      /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+/,
      /^https?:\/\/(www\.)?youtube\.com\/shorts\/[\w-]+/,
      /^https?:\/\/youtu\.be\/[\w-]+/,
      /^https?:\/\/(www\.)?youtube\.com\/v\/[\w-]+/
    ];
    
    return youtubePatterns.some(pattern => pattern.test(url));
  }

  async function fetchVideoInfo(url, format) {
    setButtonLoading(elements.getVideoBtn, true);
    hideError();
    
    try {
      const response = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, format })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch video information');
      }
      
      state.videoFetched = true;
      state.videoData = data;
      state.currentUrl = url;
      
      displayVideoInfo(data);
      
    } catch (error) {
      showError(error.message);
      throw error;
    } finally {
      const btnText = elements.getVideoBtn.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'Get Video';
      setButtonLoading(elements.getVideoBtn, false);
    }
  }

  function displayVideoInfo(data) {
    elements.thumbnail.src = data.thumbnail;
    elements.videoTitle.textContent = data.title;
    document.getElementById('uploaderText').textContent = data.uploader;
    
    showElement(elements.resultSection);
    
    renderQualityOptions(data.formats);
  }

  function renderQualityOptions(formats) {
    elements.qualityOptions.innerHTML = '';
    
    const defaultFormats = [
      { formatId: 'best', quality: 'Best', ext: 'mp4' },
      { formatId: '1080p', quality: '1080p', ext: 'mp4', filesize: null },
      { formatId: '720p', quality: '720p', ext: 'mp4', filesize: null },
      { formatId: '480p', quality: '480p', ext: 'mp4', filesize: null },
      { formatId: '360p', quality: '360p', ext: 'mp4', filesize: null }
    ];
    
    if (!formats || formats.length === 0) {
      formats = defaultFormats;
    }
    
    formats.slice(0, 6).forEach((fmt, index) => {
      const label = document.createElement('label');
      label.className = 'quality-option';
      
      const isChecked = index === 0 ? 'checked' : '';
      const filesize = fmt.filesize ? formatFileSize(fmt.filesize) : '';
      const qualityText = fmt.quality || 'Unknown';
      
      label.innerHTML = `
        <input type="radio" name="quality" value="${fmt.formatId}" data-ext="${fmt.ext}" data-quality="${fmt.quality || ''}" ${isChecked}>
        <span class="quality-option-btn">
          ${qualityText}
          ${filesize ? `<small>${filesize}</small>` : ''}
        </span>
      `;
      
      elements.qualityOptions.appendChild(label);
    });
    
    const firstInput = elements.qualityOptions.querySelector('input');
    if (firstInput) {
      state.selectedQuality = firstInput.value;
      state.selectedQualityLabel = firstInput.dataset.quality || '';
      state.selectedFormat = firstInput.dataset.ext || 'mp4';
      elements.downloadBtn.disabled = false;
    }
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(0)}${units[unitIndex]}`;
  }

  async function downloadVideo(url, formatId, format) {
    state.isLoading = true;
    setButtonLoading(elements.downloadBtn, true);
    
    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url, 
          formatId,
          quality: state.selectedQualityLabel || state.selectedQuality,
          ext: format || state.selectedFormat
        })
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Download failed');
      }
      
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `${state.videoData?.title || 'video'}.${format || 'mp4'}`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match) filename = match[1].replace(/['"]/g, '');
      }

      const reader = response.body.getReader();
      const stream = new ReadableStream({
        start(controller) {
          function pump() {
            return reader.read().then(({ done, value }) => {
              if (done) { controller.close(); return; }
              controller.enqueue(value);
              return pump();
            });
          }
          return pump();
        }
      });

      const blob = await new Response(stream).blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);
      
    } catch (error) {
      showError(error.message);
    } finally {
      state.isLoading = false;
      const btnText = elements.downloadBtn.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'Download';
      elements.downloadBtn.classList.remove('loading');
      elements.downloadBtn.disabled = false;
    }
  }

  function handlePaste() {
    try {
      navigator.clipboard.readText().then(text => {
        elements.videoUrl.value = text;
        hideError();
      }).catch(() => {
        showError('Failed to paste from clipboard');
      });
    } catch {
      showError('Failed to paste from clipboard');
    }
  }

  elements.videoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = elements.videoUrl.value.trim();
    
    if (!url) {
      showError('Please enter a YouTube URL');
      return;
    }
    
    if (!validateUrl(url)) {
      showError('Please enter a valid YouTube URL');
      return;
    }
    
    const checkedFormat = document.querySelector('input[name="format"]:checked');
    if (!checkedFormat) {
      showError('Please select a format');
      return;
    }
    state.selectedFormat = checkedFormat.value;
    
    try {
      await fetchVideoInfo(url, state.selectedFormat);
    } catch (error) {
      // Error already handled
    }
  });

  elements.videoUrl.addEventListener('input', () => {
    if (elements.videoUrl.value.trim() === '') {
      resetUI(true);
    }
  });

  elements.qualityOptions.addEventListener('change', (e) => {
    if (e.target.name === 'quality') {
      state.selectedQuality = e.target.value;
      state.selectedQualityLabel = e.target.dataset.quality || '';
      state.selectedFormat = e.target.dataset.ext || state.selectedFormat;
      elements.downloadBtn.disabled = false;
    }
  });

  elements.downloadBtn.addEventListener('click', async () => {
    if (!state.videoData || !state.selectedQuality || state.isLoading) return;
    
    const url = elements.videoUrl.value.trim();
    if (!url) return;
    
    const formatId = state.selectedQuality;
    const format = state.selectedFormat;
    
    await downloadVideo(url, formatId, format);
  });

  document.querySelectorAll('input[name="format"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const newFormat = e.target.value;
      
      if (newFormat !== state.selectedFormat) {
        state.selectedFormat = newFormat;
        
        if (state.videoFetched && state.currentUrl) {
          resetForNewFetch();
        }
      }
    });
  });

  elements.pasteBtn?.addEventListener('click', handlePaste);

})();