import { Plugin, Notice, MarkdownView, Editor, PluginSettingTab, App, Setting } from 'obsidian';

interface VoiceFormatSettings {
  serverUrl: string;
  debounceMs: number;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

const DEFAULT_SETTINGS: VoiceFormatSettings = {
  serverUrl: 'http://127.0.0.1:8080',
  debounceMs: 3000,
  systemPrompt: 'Расставь знаки препинания, заглавные буквы. Сохрани разбивку на абзацы. НЕ меняй слова. Верни ТОЛЬКО исправленный текст.',
  maxTokens: 2048,
  temperature: 0.1
};

export default class VoiceFormatPlugin extends Plugin {
  settings: VoiceFormatSettings;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProcessedLength = 0;
  private isProcessing = false;
  private autoFormatEnabled = false;
  private readonly MARKER = '<!-- voice-formatted -->';
  private statusBarEl: HTMLElement | null = null;

    async onload() {
    await this.loadSettings();
    this.addSettingTab(new VoiceFormatSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.addCommand({
      id: 'format-dictation',
      name: 'Форматировать диктовку',
      editorCallback: (editor: Editor) => {
        this.formatText(editor, false);
      }
    });

    this.addCommand({
      id: 'toggle-auto-format',
      name: 'Автоформат вкл/выкл',
      callback: () => {
        this.toggleAutoFormat();
      }
    });

    this.addCommand({
      id: 'check-server',
      name: 'Проверить LLM-сервер',
      callback: () => {
        this.checkServer();
      }
    });

    this.addRibbonIcon('mic', 'Форматировать диктовку', () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        this.formatText(view.editor, false);
      } else {
        new Notice('Откройте заметку');
      }
    });

    // Проверка сервера при запуске плагина
    this.checkServerOnStartup();
  }

  private async checkServerOnStartup() {
    try {
      const response = await fetch(this.settings.serverUrl + '/health', {
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        this.updateStatusBarText('✅ LLM');
      } else {
        this.updateStatusBarText('⚠️ LLM');
        new Notice('⚠️ LLM-сервер ответил с ошибкой. Проверьте Termux.');
      }
    } catch (e) {
      this.updateStatusBarText('❌ LLM');
      new Notice('❌ LLM-сервер недоступен. Запустите ~/start-llm.sh в Termux');
    }
  }

  private updateStatusBarText(text: string) {
    if (this.statusBarEl) {
      this.statusBarEl.setText(text);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private updateStatusBar() {
    if (!this.statusBarEl) return;
    if (this.isProcessing) {
      this.statusBarEl.setText('⏳ Форматирование...');
    } else if (this.autoFormatEnabled) {
      this.statusBarEl.setText('🎙 Автоформат');
    }
    // Не очищаем — оставляем статус сервера
  }


  toggleAutoFormat() {
    this.autoFormatEnabled = !this.autoFormatEnabled;
    if (this.autoFormatEnabled) {
      new Notice('🎙 Автоформат включён');
      this.startWatching();
    } else {
      new Notice('⏹ Автоформат выключен');
      this.stopWatching();
    }
    this.updateStatusBar();
  }

  private startWatching() {
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor: Editor) => {
        if (!this.autoFormatEnabled || this.isProcessing) return;
        this.debouncedFormat(editor);
      })
    );
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

  private async formatNewText(editor: Editor) {
    const fullText = editor.getValue();
    if (fullText.length <= this.lastProcessedLength) return;
    const newText = fullText.substring(this.lastProcessedLength).trim();
    if (newText.length < 10) return;
    await this.formatText(editor, true);
  }

  // ── Предобработка голосовых команд ───────────────

  private preprocessVoiceCommands(text: string): string {
    const commands: [RegExp, string][] = [
      [/\s*новый абзац\s*/gi,     '\n\n'],
      [/\s*новая строка\s*/gi,    '\n\n'],
      [/\s*следующая строка\s*/gi, '\n\n'],
      [/[.\s]*восклицательный знак\s*/gi, '! '],
      [/[.\s]*вопросительный знак\s*/gi,  '? '],
      [/[.\s]*точка\s*/gi,       '. '],
      [/\s*запятая\s*/gi,        ', '],
      [/\s*двоеточие\s*/gi,      ': '],
      [/\s*тире\s*/gi,           ' — '],
      [/\s*дефис\s*/gi,          '-'],
      [/\s*открыть скобку\s*/gi, ' ('],
      [/\s*закрыть скобку\s*/gi, ') '],
      [/\s*кавычки\s*/gi,        '"'],
      [/\s*многоточие\s*/gi,     '... '],
    ];

    let result = text;
    for (const [pattern, replacement] of commands) {
      result = result.replace(pattern, replacement);
    }

    result = result.replace(/ {2,}/g, ' ');
    result = result.replace(/ ([.!?,;:])/g, '$1');

    return result.trim();
  }

  // ── Форматирование ──────────────────────────────

  private async formatText(editor: Editor, autoMode: boolean) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.updateStatusBar();

    try {
      let textToFormat: string;
      let replaceStart: { line: number; ch: number };
      let replaceEnd: { line: number; ch: number };

      const selection = editor.getSelection();

      if (selection && !autoMode) {
        textToFormat = selection;
        replaceStart = editor.getCursor('from');
        replaceEnd = editor.getCursor('to');
      } else if (autoMode) {
        const fullText = editor.getValue();
        const markerPos = fullText.lastIndexOf(this.MARKER);
        const startIdx = markerPos >= 0
          ? markerPos + this.MARKER.length
          : 0;
        textToFormat = fullText.substring(startIdx).trim();

        if (textToFormat.length < 10) {
          this.isProcessing = false;
          this.updateStatusBar();
          return;
        }

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
        textToFormat = editor.getValue();
        replaceStart = { line: 0, ch: 0 };
        replaceEnd = {
          line: editor.lineCount() - 1,
          ch: editor.getLine(editor.lineCount() - 1).length
        };
      }

      if (!textToFormat.trim()) {
        this.isProcessing = false;
        this.updateStatusBar();
        return;
      }

      const preprocessed = this.preprocessVoiceCommands(textToFormat);
      const formatted = await this.callLLM(preprocessed);

      if (formatted) {
        const replacement = autoMode
          ? '\n' + this.MARKER + '\n\n' + formatted + '\n\n'
          : formatted;

        editor.replaceRange(replacement, replaceStart, replaceEnd);
        this.lastProcessedLength = editor.getValue().length;
        new Notice('✅ Отформатировано');
      }
    } catch (e) {
      new Notice('❌ ' + (e as Error).message);
    }

    this.isProcessing = false;
    this.updateStatusBar();
  }

  // ── LLM ──────────────────────────────────────────

  private async callLLM(text: string): Promise<string | null> {
    const url = this.settings.serverUrl + '/v1/chat/completions';
    const body = {
      messages: [
        { role: 'system', content: this.settings.systemPrompt },
        { role: 'user', content: text }
      ],
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxTokens
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(`Сервер: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  private async checkServer() {
    try {
      new Notice('⏳ Проверка сервера...');
      const response = await fetch(this.settings.serverUrl + '/health', {
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        new Notice('✅ Сервер доступен');
      } else {
        new Notice('⚠️ Сервер ответил: ' + response.status);
      }
    } catch (e) {
      new Notice('❌ Сервер недоступен. Запущен ли llama-server?');
    }
  }

  onunload() {
    this.stopWatching();
  }
}

// ── Страница настроек ──────────────────────────────

class VoiceFormatSettingTab extends PluginSettingTab {
  plugin: VoiceFormatPlugin;

  constructor(app: App, plugin: VoiceFormatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Voice Format — настройки' });

    new Setting(containerEl)
      .setName('Адрес LLM-сервера')
      .setDesc('URL llama.cpp сервера')
      .addText(text => text
        .setPlaceholder('http://127.0.0.1:8080')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Задержка автоформата (мс)')
      .setDesc('Пауза перед автоформатированием (минимум 500)')
      .addText(text => text
        .setValue(String(this.plugin.settings.debounceMs))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num >= 500) {
            this.plugin.settings.debounceMs = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Температура')
      .setDesc('0.0–1.0. Ниже — точнее')
      .addText(text => text
        .setValue(String(this.plugin.settings.temperature))
        .onChange(async (value) => {
          const num = parseFloat(value);
          if (!isNaN(num) && num >= 0 && num <= 1) {
            this.plugin.settings.temperature = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Макс. токенов ответа')
      .setDesc('Максимальная длина ответа LLM')
      .addText(text => text
        .setValue(String(this.plugin.settings.maxTokens))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num >= 100) {
            this.plugin.settings.maxTokens = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Системный промпт')
      .setDesc('Инструкция для LLM')
      .addTextArea(text => {
        text
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 8;
        text.inputEl.cols = 50;
      });
  }
}
