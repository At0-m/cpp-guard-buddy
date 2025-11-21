import * as vscode from 'vscode';
import * as path from 'path';

/** Элемент строки состояния, где показываем текущий тип защиты (pragma once / include guard / нет). */
let statusItem: vscode.StatusBarItem;

/**
 * Функция, которую VS Code вызывает при активации расширения.
 * Здесь создаём UI-элементы, регистрируем команды и подписываемся на события.
 *
 * @param context Контекст расширения; в него кладём объекты, требующие очистки при выгрузке.
 */
export function activate(context: vscode.ExtensionContext) {
    // создаём «плашку» в правой части статус-бара
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'cpp-guard-buddy.toggle';   // клик по плашке → переключение защиты

    // регистрируем всё, что нужно освободить при деактивации
    context.subscriptions.push(
        statusItem,

        // команды Command Palette / гор. клавиш
        vscode.commands.registerCommand('cpp-guard-buddy.insertGuard',
            () => withEditor(insertGuard)),
        vscode.commands.registerCommand('cpp-guard-buddy.usePragmaOnce',
            () => withEditor(usePragmaOnce)),
        vscode.commands.registerCommand('cpp-guard-buddy.toggle',
            () => withEditor(toggleGuardOrPragma)),

        // пересчитываем статус-бар при открытии / сохранении файла
        vscode.workspace.onDidOpenTextDocument(updateStatusBarForDoc),
        vscode.workspace.onDidSaveTextDocument(updateStatusBarForDoc),
        vscode.window.onDidChangeActiveTextEditor(e =>
            updateStatusBarForDoc(e?.document))
    );

    // инициализируем плашку для уже открытого редактора
    updateStatusBarForDoc(vscode.window.activeTextEditor?.document);
}

/**
 * Вызывается VS Code при выгрузке расширения.
 * Здесь освобождаем ресурсы (пока только статус-бар).
 */
export function deactivate() { statusItem?.dispose(); }

/**
 * Обёртка, надёжно извлекающая активный редактор.
 *
 * @param fn callback-функция, которой передаём активный TextEditor.
 */
function withEditor(fn: (ed: vscode.TextEditor) => unknown) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
        vscode.window.showInformationMessage(
            'Откройте файл заголовка C/C++ (.h, .hpp, .hh, .hxx).'
        );
        return;
    }
    return fn(ed);
}

/**
 * Проверяем, является ли файл заголовком C/C++ по расширению.
 *
 * @param doc Документ VS Code.
 * @returns true — если расширение соответствует заголовку.
 */
function isHeader(doc: vscode.TextDocument): boolean {
    return ['.h', '.hpp', '.hh', '.hxx']
        .includes(path.extname(doc.fileName).toLowerCase());
}

/**
 * Определяет, присутствует ли в первых ~50 строках директива `#pragma once`.
 *
 * @param doc Документ VS Code.
 * @returns true — если `#pragma once` найден; иначе false.
 */
function hasPragmaOnce(doc: vscode.TextDocument): boolean {
    for (let i = 0; i < Math.min(50, doc.lineCount); i++) {
        const t = doc.lineAt(i).text;
        if (/^\s*#\s*pragma\s+once\b/.test(t)) return true;
        // прерываемся на первой «содержательной» строке,
        // чтобы не сканировать комментарии/пустые строки бесконечно
        if (t.trim() && !t.trim().startsWith('//') && !t.trim().startsWith('/*')) break;
    }
    return false;
}

/**
 * Пытается извлечь классический include guard вида
 * `#ifndef MACRO … #define MACRO … #endif`.
 *
 * @param doc Документ VS Code.
 * @returns Информация о guard либо null, если guard не найден.
 */
function extractGuardMacro(doc: vscode.TextDocument): {
    macro: string;
    ifndefLine: number;
    defineLine: number;
    endifLine: number;
} | null {
    const maxTop = Math.min(60, doc.lineCount);
    let macro: string | null = null;
    let ifndefLine = -1, defineLine = -1;

    // ищем #ifndef MACRO и затем #define MACRO поблизости
    for (let i = 0; i < maxTop; i++) {
        const m = doc.lineAt(i).text.match(/^\s*#\s*ifndef\s+([A-Z0-9_]+)/);
        if (m) {
            macro = m[1];
            ifndefLine = i;
            for (let j = i + 1; j < Math.min(i + 6, maxTop); j++) {
                if (new RegExp(`^\\s*#\\s*define\\s+${macro}\\b`)
                    .test(doc.lineAt(j).text)) {
                    defineLine = j;
                    break;
                }
            }
            break;
        }
    }
    if (!macro || defineLine === -1) return null;

    // ищем завершающий #endif (желательно с комментарием макроса)
    let endif = -1;
    for (let k = doc.lineCount - 1; k >= 0; k--) {
        const t = doc.lineAt(k).text;
        if (new RegExp(`^\\s*#\\s*endif\\b.*\\b${macro}\\b`).test(t)) { endif = k; break; }
    }
    // fallback — первый встречный #endif снизу
    if (endif === -1) {
        for (let k = doc.lineCount - 1; k >= 0; k--) {
            if (/^\s*#\s*endif\b/.test(doc.lineAt(k).text)) { endif = k; break; }
        }
    }
    return endif === -1 ? null
                        : { macro, ifndefLine, defineLine, endifLine: endif };
}

/**
 * Генерирует имя макроса для include guard по относительному пути файла.
 *
 * @param doc Документ VS Code.
 * @returns Строка — уникальный макрос (пример: `SRC_UTILS_MATH_H`).
 */
function computeMacro(doc: vscode.TextDocument): string {
    const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
    const rel = ws
        ? path.relative(ws.uri.fsPath, doc.fileName)
        : path.basename(doc.fileName);
    let macro = rel.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (!/_H(PP|H|XX)?$/.test(macro)) macro += '_H';
    return macro;
}

/**
 * Вставляет include guard, если его ещё нет.
 *
 * @param ed Активный текстовый редактор.
 */
async function insertGuard(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) {
        return vscode.window.showWarningMessage(
            'Этот файл не похож на заголовок C/C++ (.h/.hpp/.hh/.hxx).'
        );
    }
    if (hasPragmaOnce(doc) || extractGuardMacro(doc)) {
        return vscode.window.showInformationMessage(
            'В файле уже есть защита от двойного включения.'
        );
    }

    const macro = computeMacro(doc);
    await ed.edit(builder => {
        builder.insert(new vscode.Position(0, 0),
            `#ifndef ${macro}\n#define ${macro}\n\n`);
        builder.insert(new vscode.Position(doc.lineCount, 0),
            `\n#endif // ${macro}\n`);
    });
    vscode.window.setStatusBarMessage(`Вставлен include guard: ${macro}`, 2500);
    updateStatusBarForDoc(doc);
}

/**
 * Добавляет `#pragma once`, убирая существующий include guard (если есть).
 *
 * @param ed Активный текстовый редактор.
 */
async function usePragmaOnce(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) {
        return vscode.window.showWarningMessage(
            'Этот файл не похож на заголовок C/C++ (.h/.hpp/.hh/.hxx).'
        );
    }
    if (hasPragmaOnce(doc)) {
        return vscode.window.showInformationMessage('#pragma once уже присутствует.');
    }

    const guard = extractGuardMacro(doc);
    await ed.edit(builder => {
        builder.insert(new vscode.Position(0, 0), '#pragma once\n\n');
        if (guard) {
            // удаляем старый guard
            builder.delete(new vscode.Range(
                guard.ifndefLine, 0,
                guard.defineLine + 1, 0
            ));
            builder.delete(new vscode.Range(
                guard.endifLine, 0,
                guard.endifLine, doc.lineAt(guard.endifLine).text.length
            ));
        }
    });
    vscode.window.setStatusBarMessage('Вставлен #pragma once', 2500);
    updateStatusBarForDoc(doc);
}

/**
 * Переключает тип защиты:
 *  * pragma once → include guard,
 *  * include guard → pragma once,
 *  * нет защиты   → вставляет include guard.
 *
 * @param ed Активный текстовый редактор.
 */
async function toggleGuardOrPragma(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) {
        return vscode.window.showWarningMessage(
            'Откройте .h/.hpp/.hh/.hxx файл.'
        );
    }

    if (hasPragmaOnce(doc)) {
        // меняем pragma once → include guard
        const macro = computeMacro(doc);
        await ed.edit(builder => {
            // удаляем pragma once в верхней части файла
            const max = Math.min(50, doc.lineCount);
            for (let i = 0; i < max; i++) {
                const line = doc.lineAt(i).text;
                if (/^\s*#\s*pragma\s+once\b/.test(line)) {
                    builder.delete(new vscode.Range(i, 0, i, line.length));
                    // убираем возможную пустую строку после неё
                    if (i + 1 < doc.lineCount &&
                        doc.lineAt(i + 1).text.trim() === '') {
                        builder.delete(new vscode.Range(
                            i + 1, 0,
                            i + 1, doc.lineAt(i + 1).text.length
                        ));
                    }
                    break;
                }
                if (line.trim()) break; // встретили код/комментарий
            }
            // добавляем include guard
            builder.insert(new vscode.Position(0, 0),
                `#ifndef ${macro}\n#define ${macro}\n\n`);
            builder.insert(new vscode.Position(doc.lineCount, 0),
                `\n#endif // ${macro}\n`);
        });
        vscode.window.setStatusBarMessage(
            'Заменили #pragma once на include guard.', 2500
        );
    } else {
        const guard = extractGuardMacro(doc);
        if (guard) {
            // меняем include guard → pragma once
            await ed.edit(builder => {
                builder.insert(new vscode.Position(0, 0), '#pragma once\n\n');
                builder.delete(new vscode.Range(
                    guard.ifndefLine, 0,
                    guard.defineLine + 1, 0
                ));
                builder.delete(new vscode.Range(
                    guard.endifLine, 0,
                    guard.endifLine, doc.lineAt(guard.endifLine).text.length
                ));
            });
            vscode.window.setStatusBarMessage(
                'Заменили include guard на #pragma once.', 2500
            );
        } else {
            // защиты не было вовсе → вставляем guard
            await insertGuard(ed);
        }
    }
    updateStatusBarForDoc(doc);
}

/**
 * Обновляет текст и видимость статус-бара
 * на основании текущего состояния открытого документа.
 *
 * @param doc Документ VS Code; если не заголовок — плашка скрывается.
 */
function updateStatusBarForDoc(doc?: vscode.TextDocument) {
    if (!doc || !isHeader(doc)) {
        return statusItem.hide();
    }

    const state = hasPragmaOnce(doc)
        ? 'pragma once'
        : (extractGuardMacro(doc) ? 'include guard' : 'нет');
    statusItem.text = `${state}`;
    statusItem.tooltip = 'Щёлкните, чтобы переключить защиту заголовка';
    statusItem.show();
}