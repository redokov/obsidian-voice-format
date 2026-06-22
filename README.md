# Voice Format — Obsidian plugin

Плагин для автоматического форматирования надиктованного текста через локальную LLM (llama.cpp). Расставляет знаки препинания, заглавные буквы, делит на абзацы — всё офлайн, на телефоне.

## Как это работает

Яндекс-клавиатура (голосовой ввод) → сырой текст в заметке
↓
плагин отправляет на localhost
↓
llama.cpp server (Qwen2.5-1.5B)
↓
текст с пунктуацией и абзацами

Два режима:
- **Ручной** — выделяете текст, нажимаете кнопку, получаете отформатированный вариант
- **Автоформат** — плагин следит за вводом и форматирует новый текст после паузы (3 сек)

## Требования

- Android-телефон с ≥8 ГБ ОЗУ
- [Termux](https://f-droid.org/packages/com.termux/) (из F-Droid, не из Google Play)
- [Obsidian](https://obsidian.md/) для Android
- ~1.5 ГБ свободного места (модель + llama.cpp)

## Установка

### 1. Настройка llama.cpp в Termux

Откройте Termux на телефоне (или подключитесь по SSH с компьютера):

```bash
# Обновление и установка зависимостей
pkg update -y && pkg upgrade -y
pkg install -y git cmake ninja clang wget

# Сборка llama.cpp
cd ~
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
cmake -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-march=armv8.2-a+dotprod" \
  -DCMAKE_CXX_FLAGS="-march=armv8.2-a+dotprod"
cmake --build build --config Release -j4

# Скачивание модели (~1.2 ГБ)
mkdir -p models && cd models
wget https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf
```


### 2. Запуск LLM-сервера
```bash

~/llama.cpp/build/bin/llama-server \
  -m ~/llama.cpp/models/qwen2.5-1.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 -c 2048 -ngl 0
```
Проверка:
```bash
curl -s http://127.0.0.1:8080/health
```
Должен ответить {"status":"ok"}.

### 4. Установка плагина в Obsidian

Вариант A — из скомпилированного релиза
```bash

# На компьютере
git clone https://github.com/redokov/obsidian-voice-format.git
cd obsidian-voice-format
npm install
npm run build

# Копируем на телефон (замените USER и IP)
ssh -p 8022 USER@IP "mkdir -p ~/storage/shared/ObsidianVault/.obsidian/plugins/voice-format"
scp -P 8022 main.js manifest.json styles.css USER@IP:~/storage/shared/ObsidianVault/.obsidian/plugins/voice-format/
Вариант B — через SSH на телефоне
bash# С компьютера
ssh -p 8022 USER@IP

# На телефоне
pkg install -y nodejs
cd ~/storage/shared/ObsidianVault/.obsidian/plugins
git clone https://github.com/redokov/obsidian-voice-format.git voice-format
cd voice-format
npm install
npm run build
```

### 4. Активация в Obsidian

Obsidian → Настройки → Сторонние плагины → Включить сторонние плагины
Перезагрузить Obsidian
Настройки → Сторонние плагины → Voice Format → Включить

Использование
Ручное форматирование

Надиктуйте текст через голосовой ввод клавиатуры
Выделите текст (или оставьте без выделения — отформатируется весь документ)
Нажмите 🎤 в боковой панели или откройте палитру команд → «Форматировать диктовку»

Автоформат (для диктовки за рулём)

Палитра команд → «Автоформат вкл/выкл»
В статус-баре появится 🎙
Диктуйте — после каждой паузы 3 сек текст автоматически форматируется
Для остановки: палитра команд → «Автоформат вкл/выкл»

Настройки плагина
ПараметрПо умолчаниюОписаниеАдрес сервераhttp://127.0.0.1:8080URL llama.cpp сервераЗадержка автоформата3000 мсПауза перед автоформатированиемТемпература0.1Креативность модели (ниже = точнее)Системный промпт(встроенный)Инструкция для LLM
SSH-доступ с компьютера (рекомендуется)
Для удобной разработки и управления:

```bash

# В Termux на телефоне (один раз)
pkg install -y openssh
passwd  # задайте пароль
sshd    # запуск SSH-сервера (порт 8022)
whoami  # запомните имя пользователя
ifconfig wlan0 | grep 'inet '  # запомните IP

# На компьютере
ssh-copy-id -p 8022 USER@IP  # чтобы не вводить пароль
Добавьте в ~/.ssh/config:
Host phone
    HostName 192.168.1.42
    Port 8022
    User u0_a342

Теперь: ssh phone
VS Code: установите расширение Remote-SSH, подключитесь к phone.
Устранение проблем
Сервер недоступен
bash# Проверить, запущен ли
ssh phone "pgrep -a llama-server"

# Если нет — запустить
ssh phone "~/llama.cpp/build/bin/llama-server \
  -m ~/llama.cpp/models/qwen2.5-1.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 -c 2048 -ngl 0 &"
```
Плагин не появляется в Obsidian

Убедитесь, что main.js и manifest.json лежат в .obsidian/plugins/voice-format/
Перезапустите Obsidian
Включите «Сторонние плагины» в настройках

Медленное форматирование

Увеличьте задержку автоформата до 5000 мс
Убедитесь, что других тяжёлых приложений нет в памяти
При длительной работе телефон может греться и тормозить — дайте остыть

Лицензия
MIT
