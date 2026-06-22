import { Plugin, Notice, MarkdownView, Editor } from 'obsidian';

interface VoiceFormatSettings {
  serverUrl: string;
  debounceMs: number;
  systemPrompt: string;
}

const DEFAULT_SETTINGS: VoiceFormatSettings = {
  serverUrl: 'http://127.0.0.1:8080',
  debounceMs: 3000,  // ждём 3 сек паузы перед форматированием
  systemPrompt: `Ты — корректор диктовки. Исправь текст:
- Расставь точки, запятые, вопросительные и восклицательные знаки
- Расставь заглавные буквы после точек и в начале текста
- Раздели на абзацы по смыслу (пустая строка между абзацами)
- НЕ меняй слова, НЕ добавляй и НЕ удаляй слова
- Верни ТОЛЬКО исправленный текст, без комментариев`
};

export default class VoiceFormatPlugin extends Plugin {
  settings: VoiceFormatSettings;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProcessedLength = 0;
  private isProcessing = false;
  // Маркер: текст до этой строки уже отформатирован
  private readonly MARKER = '<!-- voice-formatted -->';

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);

    // Команда: форматировать выделенный текст или весь документ
    this.addCommand({
      id: 'format-dictation',
      name: 'Форматировать диктовку',
      editorCallback: (editor: Editor) => {
        this.formatText(editor, false);
      }
    });

    // Команда: включить/выключить автоформат
    this.addCommand({
      id: 'toggle-auto-format',
      name: 'Автоформат вкл/выкл',
      callback: () => {
        this.toggleAutoFormat();
      }
    });

    // Иконка в боковой панели
    this.addRibbonIcon('mic', 'Voice Format', () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        this.formatText(view.editor, false);
      }
    });
  }

  // ── Автоформат по паузе ──────────────────────────

  private autoFormatEnabled = false;
  private editorChangeRef: (() => void) | null = null;

  toggleAutoFormat() {
    this.autoFormatEnabled = !this.autoFormatEnabled;

    if (this.autoFormatEnabled) {
      new Notice('🎙 Автоформат включён');
      this.startWatching();
    } else {
      new Notice('⏹ Автоформат выключен');
      this.stopWatching();
    }
  }

  private startWatching() {
    // Слушаем изменения в редакторе
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor: Editor) => {
        if (!this.autoFormatEnabled || this.isProcessing) return;
        this.debouncedFormat(editor);
      })
    );

    // Запоминаем текущую длину как "уже обработанное"
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      this.lastProcessedLength = view.editor.getValue().length;
    }
  }

  private stopWatching() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private debouncedFormat(editor: Editor) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.formatNewText(editor);
    }, this.settings.debounceMs);
  }

  // ── Форматирование ──────────────────────────────

  // Форматировать только новый текст (для автоформата)
  private async formatNewText(editor: Editor) {
    const fullText = editor.getValue();
    if (fullText.length <= this.lastProcessedLength) return;

    const newText = fullText.substring(this.lastProcessedLength).trim();
    if (newText.length < 10) return; // слишком мало текста

    await this.formatText(editor, true);
  }

  // Основная функция форматирования
  private async formatText(editor: Editor, autoMode: boolean) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      let textToFormat: string;
      let replaceStart: { line: number; ch: number };
      let replaceEnd: { line: number; ch: number };

      const selection = editor.getSelection();

      if (selection && !autoMode) {
        // Ручной режим: форматируем выделенное
        textToFormat = selection;
        replaceStart = editor.getCursor('from');
        replaceEnd = editor.getCursor('to');
      } else if (autoMode) {
        // Автоформат: берём текст после последнего маркера
        const fullText = editor.getValue();
        const markerPos = fullText.lastIndexOf(this.MARKER);
        const startIdx = markerPos >= 0
          ? markerPos + this.MARKER.length
          : 0;
        textToFormat = fullText.substring(startIdx).trim();

        if (textToFormat.length < 10) {
          this.isProcessing = false;
          return;
        }

        // Вычисляем позиции для замены
        const lines = fullText.substring(0, startIdx).split('\n');
        replaceStart = {
          line: lines.length - 1,
          ch: lines[lines.length - 1].length
        };
        replaceEnd = {
          line: editor.lineCount() - 1,
          ch: editor.getLine(editor.lineCount() - 1).length
        };
      } else {
        // Ручной режим без выделения: весь документ
        textToFormat = editor.getValue();
        replaceStart = { line: 0, ch: 0 };
        replaceEnd = {
          line: editor.lineCount() - 1,
          ch: editor.getLine(editor.lineCount() - 1).length
        };
      }

      if (!textToFormat.trim()) {
        this.isProcessing = false;
        return;
      }

      new Notice('⏳ Форматирование...');

      const formatted = await this.callLLM(textToFormat);

      if (formatted) {
        const replacement = autoMode
          ? '\n' + this.MARKER + '\n\n' + formatted + '\n\n'
          : formatted;

        editor.replaceRange(replacement, replaceStart, replaceEnd);
        this.lastProcessedLength = editor.getValue().length;

        new Notice('✅ Отформатировано');
      }
    } catch (e) {
      new Notice('❌ Ошибка: ' + (e as Error).message);
    }

    this.isProcessing = false;
  }

  // ── Вызов LLM ────────────────────────────────────

  private async callLLM(text: string): Promise<string | null> {
    const url = this.settings.serverUrl + '/v1/chat/completions';

    const body = {
      messages: [
        { role: 'system', content: this.settings.systemPrompt },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      max_tokens: Math.max(text.length * 2, 500)
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim();

    return result || null;
  }

  onunload() {
    this.stopWatching();
  }
}
