const LANGUAGES = {
  kor: { filename: "korean_emotion_list.txt", count: 988, locale: "ko-KR" },
  eng: { filename: "english_emotion_list.txt", count: 601, locale: "en" }
};

const TEXT = {
  kor: {
    list: "일치하는 감정 표현",
    noMatch: "일치하는 감정 표현이 없습니다.",
    more: count => `일치하는 감정 표현 ${count}개 모두 보기`,
    invalid: "목록에 있는 감정 표현을 선택하거나 정확히 입력해 주세요.",
    duplicate: "이미 입력한 감정입니다",
    count: count => `입력한 감정 수 ${count}`,
    remove: word => `${word} 삭제`
  },
  eng: {
    list: "Matching emotion expressions",
    noMatch: "No matching emotion expressions.",
    more: count => `Show all ${count} matching expressions`,
    invalid: "Select an expression from the list or type a complete listed expression.",
    duplicate: "This expression has already been added.",
    count: count => `Emotions added: ${count}`,
    remove: word => `Remove ${word}`
  }
};

export function emotionResponseText(language) {
  if (!Object.hasOwn(TEXT, language)) throw new Error("EMOTION_LANGUAGE_INVALID");
  return TEXT[language];
}

export function normalizeEmotion(value) {
  return value.trim().replace(/\s+/g, " ");
}

// Ignore whitespace only for searching; keep canonical expressions intact.
function emotionSearchKey(value, language) {
  const compact = value.replace(/\s+/g, "");
  return language === "eng" ? compact.toLocaleLowerCase("en") : compact;
}

export function parseEmotionVocabulary(text, language) {
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error("EMOTION_LANGUAGE_INVALID");
  if (typeof text !== "string") throw new Error("EMOTION_VOCABULARY_INVALID");
  const { count, locale } = LANGUAGES[language];
  const key = value => language === "eng" ? value.toLocaleLowerCase("en") : value;
  const expressions = text.split(",").map(word => word.trim());
  if (expressions.length !== count ||
      expressions.some(word => !word || /[\u0000-\u001f\u007f\ufffd]/.test(word)) ||
      new Set(expressions.map(key)).size !== expressions.length) {
    throw new Error("EMOTION_VOCABULARY_INVALID");
  }
  if (Intl.Collator.supportedLocalesOf(locale).length !== 1) {
    throw new Error("EMOTION_SORT_LOCALE_UNAVAILABLE");
  }
  expressions.sort(new Intl.Collator(locale).compare);
  const canonical = new Map(expressions.map(word => [key(word), word]));
  const allowed = new Set(expressions);
  return Object.freeze({
    language,
    expressions: Object.freeze(expressions),
    matches(query) {
      const needle = emotionSearchKey(query, language);
      return needle ? expressions.filter(word => emotionSearchKey(word, language).includes(needle)) : [];
    },
    resolve(value) { return canonical.get(key(normalizeEmotion(value))); },
    has(value) { return allowed.has(value); }
  });
}

export async function loadEmotionVocabulary(language) {
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error("EMOTION_LANGUAGE_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(new URL(LANGUAGES[language].filename, import.meta.url), {
      signal: controller.signal, cache: "no-store"
    });
    if (!response.ok) throw new Error("EMOTION_VOCABULARY_HTTP_ERROR");
    return parseEmotionVocabulary(await response.text(), language);
  } finally {
    clearTimeout(timeout);
  }
}

export function loadGuidedEmotionStyles(document) {
  if (!document?.head) throw new Error("EMOTION_STYLE_DOCUMENT_MISSING");
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    const timeout = setTimeout(() => finish(new Error("EMOTION_STYLE_TIMEOUT")), 30000);
    function finish(error) {
      clearTimeout(timeout);
      link.onload = null;
      link.onerror = null;
      if (error) { link.remove(); reject(error); }
      else resolve();
    }
    link.rel = "stylesheet";
    link.href = new URL("./guided-emotion.css", import.meta.url).href;
    link.onload = () => finish();
    link.onerror = () => finish(new Error("EMOTION_STYLE_LOAD_FAILED"));
    document.head.appendChild(link);
  });
}

// Trial-local dropdown state. The caller retains response tags and data recording.
export function mountGuidedEmotionInput({ display, vocabulary, onSelect, onInput }) {
  const text = emotionResponseText(vocabulary.language);
  const document = display.ownerDocument;
  const input = display.querySelector("#emotion-keyword-input");
  const menu = display.querySelector("#emotion-suggestions");
  const list = display.querySelector("#emotion-options");
  const empty = display.querySelector("#emotion-no-matches");
  if (!document || !input || !menu || !list || !empty ||
      typeof onSelect !== "function" || typeof onInput !== "function") {
    throw new Error("EMOTION_RESPONSE_ELEMENTS_MISSING");
  }
  const listeners = [];
  let expanded = false;
  let opened = true;
  let active = -1;
  let composing = false;
  let matches = [];

  function listen(target, name, handler) {
    target.addEventListener(name, handler);
    listeners.push(() => target.removeEventListener(name, handler));
  }

  function render() {
    const query = normalizeEmotion(input.value);
    matches = vocabulary.matches(query);
    const visible = expanded ? matches : matches.slice(0, 5);
    const showMore = !expanded && matches.length > 5;
    if (active >= visible.length + Number(showMore)) active = -1;
    menu.hidden = !query || !opened;
    list.hidden = matches.length === 0;
    empty.hidden = matches.length !== 0;
    empty.textContent = text.noMatch;
    list.setAttribute("aria-label", text.list);
    list.classList.toggle("is-expanded", expanded);
    const scrollTop = list.scrollTop;
    list.replaceChildren();

    function option(label, index, select) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emotion-option";
      button.id = `emotion-option-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === active));
      button.classList.toggle("is-active", index === active);
      button.textContent = label;
      // Preserve input focus until click, including when the IME is active.
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", event => {
        // Expansion replaces this button. Do not let the same click reach the
        // outside-click handler after its target has been detached from the menu.
        event.stopPropagation();
        select();
      });
      list.appendChild(button);
      return button;
    }

    visible.forEach((word, index) => {
      const button = option(word, index, () => {
        // A pointer choice is explicit even while the final Korean syllable is
        // composing. Blur commits that composition before the caller clears input.
        if (composing) input.blur();
        composing = false;
        onSelect(word);
      });
      const needle = emotionSearchKey(query, vocabulary.language);
      const start = emotionSearchKey(word, vocabulary.language).indexOf(needle);
      if (start >= 0) {
        // Map the compact match back to the original text, including its spaces.
        const positions = Array.from(word.matchAll(/\S/g), match => match.index);
        const originalStart = positions[start];
        const originalEnd = positions[start + needle.length - 1] + 1;
        const match = document.createElement("span");
        match.className = "emotion-match";
        match.textContent = word.slice(originalStart, originalEnd);
        button.replaceChildren(document.createTextNode(word.slice(0, originalStart)), match,
          document.createTextNode(word.slice(originalEnd)));
      }
    });
    if (showMore) {
      const more = option("...", visible.length, expand);
      more.classList.add("emotion-more");
      more.setAttribute("aria-label", text.more(matches.length));
    }
    list.scrollTop = scrollTop;
    input.setAttribute("aria-expanded", String(!menu.hidden));
    if (active >= 0 && !menu.hidden) {
      input.setAttribute("aria-activedescendant", `emotion-option-${active}`);
      const button = list.children[active];
      if (expanded) {
        if (button.offsetTop < list.scrollTop) list.scrollTop = button.offsetTop;
        else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight;
        }
      }
    } else input.removeAttribute("aria-activedescendant");
  }

  function expand() {
    expanded = true;
    active = -1;
    list.scrollTop = 0;
    render();
    input.focus();
  }

  function reset() {
    expanded = false;
    opened = true;
    active = -1;
    list.scrollTop = 0;
    render();
  }

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  listen(input, "input", () => { reset(); onInput(); });
  listen(input, "compositionstart", () => { composing = true; onInput(); });
  listen(input, "compositionend", () => { composing = false; reset(); onInput(); });
  listen(input, "focus", () => { opened = true; render(); });
  listen(input, "keydown", event => {
    if (event.isComposing || event.keyCode === 229 || composing ||
        event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      opened = false; active = -1; render();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      opened = true;
      const length = (expanded ? matches.length : Math.min(matches.length, 5)) +
        Number(!expanded && matches.length > 5);
      if (length) {
        active = active < 0 ? (event.key === "ArrowDown" ? 0 : length - 1)
          : (active + (event.key === "ArrowDown" ? 1 : -1) + length) % length;
      }
      render();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    const visibleCount = expanded ? matches.length : Math.min(matches.length, 5);
    if (!menu.hidden && active >= 0 && active < visibleCount) onSelect(matches[active]);
    else if (!menu.hidden && active === visibleCount && matches.length > 5 && !expanded) expand();
    else if (normalizeEmotion(input.value)) onSelect(input.value);
  });
  listen(display, "click", event => {
    if (event.target !== input && !menu.contains(event.target)) {
      opened = false; active = -1; render();
    }
  });
  listen(display, "focusout", event => {
    if (event.relatedTarget !== input && !menu.contains(event.relatedTarget)) {
      opened = false; active = -1; render();
    }
  });
  reset();
  return {
    reset,
    isComposing: () => composing,
    destroy() {
      listeners.forEach(remove => remove());
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      list.replaceChildren();
    }
  };
}
