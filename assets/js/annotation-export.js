export function annotationExport(library, csrf, api, reposition) {
  const section = library.querySelector('[data-export]');
  const discussion = library.querySelector('[data-discussion-view]');
  const open = section.querySelector('[data-export-open]');
  const check = section.querySelector('[data-export-check]');
  const result = section.querySelector('[data-export-result]');
  const fields = library.querySelector('[data-export-fields]');
  const form = fields.querySelector('form');
  const title = form.elements.title;
  const summary = form.elements.summary;
  const choices = fields.querySelector('[data-export-choices]');
  const retry = fields.querySelector('[data-export-retry]');
  const cancel = section.querySelector('[data-export-cancel]');
  const confirm = section.querySelector('[data-export-confirm]');
  const status = section.querySelector('[data-export-status]');
  let current;
  let proof;
  let busy = false;
  let previewTimer;
  let previewRevision = 0;

  function hideEditor() {
    clearTimeout(previewTimer);
    previewRevision++;
    const wasOpen = !fields.hidden;
    fields.hidden = true;
    discussion.hidden = false;
    cancel.hidden = confirm.hidden = true;
    form.inert = false;
    library.removeAttribute('data-export-editing');
    proof = null;
    confirm.disabled = true;
    if (wasOpen) reposition();
  }

  function reset() {
    current = null;
    status.textContent = '';
    section.hidden = true;
    result.hidden = true;
    hideEditor();
  }

  function renderPublication(publication) {
    current.thread.publication = publication;
    const pending = ['sending', 'checking'].includes(publication.state);
    result.hidden = !publication.url;
    if (publication.url) {
      const number = publication.url.match(/\/issues\/(\d+)$/)?.[1];
      result.href = publication.url;
      result.textContent = number ? `Otwórz zgłoszenie #${number}` : 'Otwórz zgłoszenie';
    }
    open.hidden = !current.thread.can_publish || pending || Boolean(publication.url);
    check.hidden = !current.thread.can_publish || !pending;
    if (pending) status.textContent = 'Wynik wysyłki wymaga sprawdzenia.';
    if (publication.state === 'failed') status.textContent = 'GitHub odrzucił wysyłkę. Możesz przygotować ją ponownie.';
  }

  function show(entry, thread) {
    reset();
    current = { entry, thread };
    section.hidden = !thread.can_publish && !thread.publication.url;
    renderPublication(thread.publication);
  }

  async function request(action, selected, payload) {
    payload.set('csrf', csrf);
    const response = await fetch(`${api}&watek=${selected.entry.id}&publikacja=${action}`, {
      method: 'POST', body: payload,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw new Error(data?.error || 'Nie udało się wykonać tej akcji.');
    }
    return data;
  }

  function validateDraft(delay = 0) {
    clearTimeout(previewTimer);
    const revision = ++previewRevision;
    const selected = current;
    proof = null;
    confirm.disabled = true;
    retry.hidden = true;
    if (!title.value.trim() || !summary.value.trim()) {
      status.textContent = 'Uzupełnij tytuł i opis zgłoszenia.';
      return;
    }
    status.textContent = 'Sprawdzam treść zgłoszenia…';
    previewTimer = setTimeout(async () => {
      try {
        const data = await request('preview', selected, new FormData(form));
        if (revision !== previewRevision || current !== selected) return;
        proof = data.proof;
        const draft = data.draft;
        let redacted = false;
        if (typeof draft?.title === 'string') { title.value = draft.title; redacted = true; }
        if (typeof draft?.summary === 'string') { summary.value = draft.summary; redacted = true; }
        if (draft?.replies) {
          for (const label of choices.children) {
            const input = label.firstElementChild;
            const reply = draft.replies.find(item => String(item.id) === input.value);
            if (reply) label.lastChild.textContent = reply.comment;
          }
        }
        confirm.disabled = !proof || !selected.thread.publication_configured;
        status.textContent = [
          redacted ? 'Dane prywatne oznaczono jako [ukryto].' : '',
          selected.thread.publication_configured ? '' : 'Wysyłka wymaga podpięcia GitHub App.',
        ].filter(Boolean).join(' ');
        reposition();
      } catch (error) {
        if (revision !== previewRevision || current !== selected) return;
        status.textContent = error.message;
        retry.hidden = false;
      }
    }, delay);
  }

  async function send(action, payload) {
    if (busy || !current) return;
    const selected = current;
    busy = true;
    open.disabled = check.disabled = confirm.disabled = cancel.disabled = true;
    form.inert = true;
    status.textContent = 'Sprawdzam publikację…';
    try {
      const data = await request(action, selected, payload);
      if (current !== selected) return;
      status.textContent = '';
      hideEditor();
      renderPublication(data);
    } catch (error) {
      if (current === selected) {
        status.textContent = error.message;
        if (action === 'send') {
          proof = null;
          retry.hidden = false;
        }
      }
    } finally {
      busy = false;
      open.disabled = check.disabled = cancel.disabled = form.inert = false;
      confirm.disabled = !proof || current?.thread.publication_configured !== true;
    }
  }

  open.addEventListener('click', () => {
    if (!current.draftInitialized) {
      title.value = current.entry.comment.trim().split('\n')[0].slice(0, 100);
      summary.value = current.entry.comment;
      choices.replaceChildren(...current.thread.replies.map(reply => {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'reply';
        checkbox.value = reply.id;
        label.append(checkbox, document.createTextNode(reply.comment));
        return label;
      }));
      current.draftInitialized = true;
    }
    fields.hidden = false;
    discussion.hidden = true;
    cancel.hidden = confirm.hidden = false;
    library.setAttribute('data-export-editing', '');
    open.hidden = true;
    title.focus();
    reposition();
    validateDraft();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    validateDraft();
  });
  form.addEventListener('input', () => validateDraft(250));
  cancel.addEventListener('click', () => {
    hideEditor();
    status.textContent = '';
    renderPublication(current.thread.publication);
    open.focus();
  });
  confirm.addEventListener('click', () => {
    if (!proof || !current?.thread.publication_configured) return;
    const data = new FormData();
    data.set('proof', proof);
    void send('send', data);
  });
  check.addEventListener('click', () => void send('check', new FormData()));

  return { show, reset };
}
