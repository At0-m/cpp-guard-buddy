```ts
import * as vscode from 'vscode';
import * as path from 'path';

// Глобальный статус-бар-элемент. 
let statusItem: vscode.StatusBarItem;

//Точка входа расширения. Создаёт статус-бар, регистрирует команды и события.

export function activate(context: vscode.ExtensionContext) {
    // Статус-бар справа, приоритет 100
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'cpp-guard-buddy.toggle';

    // Регистрируем всё, что нужно удалить при выгрузке расширения
    context.subscriptions.push(
        statusItem,
        vscode.commands.registerCommand(
            'cpp-guard-buddy.insertGuard',
            () => withEditor(insertGuard)
        ),
        vscode.commands.registerCommand(
            'cpp-guard-buddy.usePragmaOnce',
            () => withEditor(usePragmaOnce)
        ),
        vscode.commands.registerCommand(
            'cpp-guard-buddy.toggle',
            () => withEditor(toggleGuardOrPragma)
        ),
        vscode.workspace.onDidOpenTextDocument(updateStatusBarForDoc),
        vscode.workspace.onDidSaveTextDocument(updateStatusBarForDoc),
        vscode.window.onDidChangeActiveTextEditor(e => updateStatusBarForDoc(e?.document))
    );

    // Инициализируем статус для текущего активного редактора
    updateStatusBarForDoc(vscode.window.activeTextEditor?.document);
}

// Вызывается при деактивации расширения (VS Code закрывает процесс).
export function deactivate() {
    statusItem?.dispose();
}

/**
 * Вспомогательная обёртка: проверяет, открыт ли редактор,
 * и передаёт его в переданную функцию.
 * @param fn функция, получающая активный TextEditor
 */
function withEditor(fn: (ed: vscode.TextEditor) => void) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
        vscode.window.showInformationMessage('Откройте файл заголовка C/C++ (.h, .hpp, .hh, .hxx).');
        return;
    }
    fn(ed);
}

/**
 * Проверка расширения файла на заголовочный C/C++.
 * @param doc документ VS Code
 */
function isHeader(doc: vscode.TextDocument): boolean {
    return ['.h', '.hpp', '.hh', '.hxx'].includes(
        path.extname(doc.fileName).toLowerCase()
    );
}

/**
 * Есть ли `#pragma once` в первых ~50 строках документа.
 * @param doc документ
 */
function hasPragmaOnce(doc: vscode.TextDocument): boolean {
    for (let i = 0; i < Math.min(50, doc.lineCount); i++) {
        const text = doc.lineAt(i).text;
        if (/^\s*#\s*pragma\s+once\b/.test(text)) return true;
        if (text.trim() && !text.trim().startsWith('//') && !text.trim().startsWith('/*')) break;
    }
    return false;
}

/**
 * Пытается найти include guard формата
 * `#ifndef MACRO` … `#define MACRO` … `#endif`.
 * @returns информацию о макросе или `null`, если guard не найден
 */
function extractGuardMacro(doc: vscode.TextDocument): {
    macro: string;
    ifndefLine: number;
    defineLine: number;
    endifLine: number;
} | null {
    const maxTop = Math.min(60, doc.lineCount);
    let macro: string | null = null;
    let ifndefLine = -1;
    let defineLine = -1;

    // Ищем #ifndef / #define в верхней части
    for (let i = 0; i < maxTop; i++) {
        const m = doc.lineAt(i).text.match(/^\s*#\s*ifndef\s+([A-Z0-9_]+)/);
        if (m) {
            macro = m[1];
            ifndefLine = i;
            // ищем #define того же макроса недалеко
            for (let j = i + 1; j < Math.min(i + 6, maxTop); j++) {
                if (new RegExp(`^\\s*#\\s*define\\s+${macro}\\b`).test(doc.lineAt(j).text)) {
                    defineLine = j;
                    break;
                }
            }
            break;
        }
    }
    if (!macro || defineLine === -1) return null;

    // Ищем #endif (предпочтительно с комментарием макроса)
    let endif = -1;
    for (let k = doc.lineCount - 1; k >= 0; k--) {
        const t = doc.lineAt(k).text;
        if (new RegExp(`^\\s*#\\s*endif\\b.*\\b${macro}\\b`).test(t)) { endif = k; break; }
    }
    // Если #endif с комментарием не нашёлся, берём первый встречный снизу
    if (endif === -1) {
        for (let k = doc.lineCount - 1; k >= 0; k--) {
            if (/^\s*#\s*endif\b/.test(doc.lineAt(k).text)) { endif = k; break; }
        }
    }
    return endif === -1 ? null : { macro, ifndefLine, defineLine, endifLine: endif };
}

//Генерирует имя include guard-макроса по относительному пути файла.
function computeMacro(doc: vscode.TextDocument): string {
    const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
    const rel = ws ? path.relative(ws.uri.fsPath, doc.fileName) : path.basename(doc.fileName);
    let macro = rel.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (!/_H(PP|H|XX)?$/.test(macro)) macro += '_H';
    return macro;
}

//Вставляет классический include guard, если защиты ещё нет.
async function insertGuard(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) {
        vscode.window.showWarningMessage('Этот файл не похож на заголовок C/C++ (.h/.hpp/.hh/.hxx).');
        return;
    }
    if (hasPragmaOnce(doc) || extractGuardMacro(doc)) {
        vscode.window.showInformationMessage('Защита уже существует.');
        return;
    }

    const macro = computeMacro(doc);
    await ed.edit(b => {
        b.insert(new vscode.Position(0, 0), `#ifndef ${macro}\n#define ${macro}\n\n`);
        b.insert(new vscode.Position(doc.lineCount, 0), `\n#endif // ${macro}\n`);
    });
    vscode.window.setStatusBarMessage(`Вставлен include guard: ${macro}`, 2500);
    updateStatusBarForDoc(doc);
}

//Заменяет (или добавляет) `#pragma once`, убирая include guard при его наличии.
async function usePragmaOnce(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) {
        vscode.window.showWarningMessage('Этот файл не похож на заголовок C/C++ (.h/.hpp/.hh/.hxx).');
        return;
    }
    if (hasPragmaOnce(doc)) {
        vscode.window.showInformationMessage('#pragma once уже присутствует.');
        return;
    }

    const guard = extractGuardMacro(doc);
    await ed.edit(b => {
        // Вставляем pragma once в самое начало
        b.insert(new vscode.Position(0, 0), '#pragma once\n\n');
        // Удаляем старый guard, если был
        if (guard) {
            b.delete(new vscode.Range(guard.ifndefLine, 0, guard.defineLine + 1, 0));
            b.delete(new vscode.Range(
                guard.endifLine, 0,
                guard.endifLine, doc.lineAt(guard.endifLine).text.length
            ));
        }
    });
    vscode.window.setStatusBarMessage('Вставлен #pragma once', 2500);
    updateStatusBarForDoc(doc);
}

/**
 * Переключает текущий тип защиты:
 * * pragma once → include guard  
 * * include guard → pragma once  
 * * нет защиты   → вставляет guard.
 */
async function toggleGuardOrPragma(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) {
        vscode.window.showWarningMessage('Откройте .h/.hpp/.hh/.hxx файл.');
        return;
    }

    if (hasPragmaOnce(doc)) {
        // Меняем pragma once → guard
        const macro = computeMacro(doc);
        await ed.edit(b => {
            // Удаляем pragma once
            const max = Math.min(50, doc.lineCount);
            for (let i = 0; i < max; i++) {
                const line = doc.lineAt(i).text;
                if (/^\s*#\s*pragma\s+once\b/.test(line)) {
                    b.delete(new vscode.Range(i, 0, i, line.length));
                    if (i + 1 < doc.lineCount && doc.lineAt(i + 1).text.trim() === '') {
                        b.delete(new vscode.Range(i + 1, 0, i + 1, doc.lineAt(i + 1).text.length));
                    }
                    break;
                }
                if (line.trim()) break; // встретили код/непустой комментарий
            }
            // Добавляем guard
            b.insert(new vscode.Position(0, 0), `#ifndef ${macro}\n#define ${macro}\n\n`);
            b.insert(new vscode.Position(doc.lineCount, 0), `\n#endif // ${macro}\n`);
        });
        vscode.window.setStatusBarMessage('Заменили #pragma once на include guard.', 2500);
    } else {
        const guard = extractGuardMacro(doc);
        if (guard) {
            // Меняем guard → pragma once
            await ed.edit(b => {
                b.insert(new vscode.Position(0, 0), '#pragma once\n\n');
                b.delete(new vscode.Range(guard.ifndefLine, 0, guard.defineLine + 1, 0));
                b.delete(new vscode.Range(
                    guard.endifLine, 0,
                    guard.endifLine, doc.lineAt(guard.endifLine).text.length
                ));
            });
            vscode.window.setStatusBarMessage('Заменили include guard на #pragma once.', 2500);
        } else {
            // Защиты не было → вставляем guard
            await insertGuard(ed);
        }
    }
    updateStatusBarForDoc(doc);
}

/**
 * Обновляет текст и видимость статус-бара
 * в зависимости от состояния открытого документа.
 */
function updateStatusBarForDoc(doc?: vscode.TextDocument) {
    if (!doc || !isHeader(doc)) {
        statusItem.hide();
        return;
    }
    const state = hasPragmaOnce(doc)
        ? 'pragma once'
        : (extractGuardMacro(doc) ? 'include guard' : 'нет');
    statusItem.text = `${state}`;
    statusItem.tooltip = 'Щёлкните, чтобы переключить защиту заголовка';
    statusItem.show();
}