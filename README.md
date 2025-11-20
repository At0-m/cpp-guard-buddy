# C/C++ Header Guard Buddy

**Автор:** Цыков Александр
**IDE:** VS Code  
**Плагин:** автоматизация защиты заголовков C/C++ — вставка include guard / `#pragma once`, переключение форматов, индикатор в статус-баре.

## Возможности
- Вставка include guard по имени файла/пути: `#ifndef … #define … #endif`.
- Вставка `#pragma once`.
- Переключение guard ↔ `#pragma once` одной командой.
- Индикация состояния в статус-баре.

## Команды
- `Header Guard: Insert include guard`
- `Header Guard: Use #pragma once`
- `Header Guard: Toggle guard/pragma`
- Горячая клавиша: `Ctrl+Alt+G` (в редакторе заголовков).

## Установка и запуск
```bash
git clone https://github.com/<user>/cpp-guard-buddy.git
cd cpp-guard-buddy
npm install
npm run compile
# Запуск в режиме разработки:
# В VS Code → Run (F5) → Extension Development Host