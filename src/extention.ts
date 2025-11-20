import * as vscode from 'vscode';
import * as path from 'path';

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'cpp-guard-buddy.toggle';
    context.subscriptions.push(
        statusItem,
        vscode.commands.registerCommand('cpp-guard-buddy.insertGuard', () => withEditor(insertGuard)),
        vscode.commands.registerCommand('cpp-guard-buddy.usePragmaOnce', () => withEditor(usePragmaOnce)),
        vscode.commands.registerCommand('cpp-guard-buddy.toggle', () => withEditor(toggleGuardOrPragma)),
        vscode.workspace.onDidOpenTextDocument(updateStatusBarForDoc),
        vscode.workspace.onDidSaveTextDocument(updateStatusBarForDoc),
        vscode.window.onDidChangeActiveTextEditor(e => updateStatusBarForDoc(e?.document))
    );
    updateStatusBarForDoc(vscode.window.activeTextEditor?.document);
}

export function deactivate() { statusItem?.dispose(); }

function withEditor(fn: (ed: vscode.TextEditor) => any) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return vscode.window.showInformationMessage('Откройте файл заголовка C/C++ (.h, .hpp, .hh).');
    return fn(ed);
}

function isHeader(doc: vscode.TextDocument): boolean {
    return ['.h', '.hpp', '.hh', '.hxx'].includes(path.extname(doc.fileName).toLowerCase());
}

function hasPragmaOnce(doc: vscode.TextDocument): boolean {
    for (let i = 0; i < Math.min(50, doc.lineCount); i++) {
        const t = doc.lineAt(i).text;
        if (/^\s*#\s*pragma\s+once\b/.test(t)) return true;
        if (t.trim() && !t.trim().startsWith('//') && !t.trim().startsWith('/*')) break;
    }
    return false;
}

function extractGuardMacro(doc: vscode.TextDocument): { macro: string, ifndefLine: number, defineLine: number, endifLine: number } | null {
    const maxTop = Math.min(60, doc.lineCount);
    let macro: string | null = null, ifndefLine = -1, defineLine = -1;
    for (let i = 0; i < maxTop; i++) {
        const m = doc.lineAt(i).text.match(/^\s*#\s*ifndef\s+([A-Z0-9_]+)/);
        if (m) {
            macro = m[1]; ifndefLine = i;
            for (let j = i + 1; j < Math.min(i + 6, maxTop); j++) {
                if (new RegExp('^\\s*#\\s*define\\s+' + macro + '\\b').test(doc.lineAt(j).text)) { defineLine = j; break; }
            }
            break;
        }
    }
    if (!macro || defineLine === -1) return null;
    let endif = -1;
    for (let k = doc.lineCount - 1; k >= 0; k--) {
        const t = doc.lineAt(k).text;
        if (new RegExp('^\\s*#\\s*endif\\b.*\\b' + macro + '\\b').test(t)) { endif = k; break; }
    }
    if (endif === -1) for (let k = doc.lineCount - 1; k >= 0; k--) { if (/^\s*#\s*endif\b/.test(doc.lineAt(k).text)) { endif = k; break; } }
    return endif === -1 ? null : { macro, ifndefLine, defineLine, endifLine: endif };
}

function computeMacro(doc: vscode.TextDocument): string {
    const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
    let rel = ws ? path.relative(ws.uri.fsPath, doc.fileName) : path.basename(doc.fileName);
    let macro = rel.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (!/_H(PP|H|XX)?$/.test(macro)) macro += '_H';
    return macro;
}

async function insertGuard(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) return vscode.window.showWarningMessage('Этот файл не похож на заголовок C/C++ (.h/.hpp/.hh/.hxx).');
    if (hasPragmaOnce(doc) || extractGuardMacro(doc)) return vscode.window.showInformationMessage('В файле уже есть защита от двойного включения.');
    const macro = computeMacro(doc);
    await ed.edit(b => {
        b.insert(new vscode.Position(0, 0), `#ifndef ${macro}\n#define ${macro}\n\n`);
        b.insert(new vscode.Position(doc.lineCount, 0), `\n#endif // ${macro}\n`);
    });
    vscode.window.setStatusBarMessage(`Вставлен include guard: ${macro}`, 2500);
    updateStatusBarForDoc(doc);
}

async function usePragmaOnce(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) return vscode.window.showWarningMessage('Этот файл не похож на заголовок C/C++ (.h/.hpp/.hh/.hxx).');
    if (hasPragmaOnce(doc)) return vscode.window.showInformationMessage('#pragma once уже присутствует.');
    const guard = extractGuardMacro(doc);
    await ed.edit(b => {
        b.insert(new vscode.Position(0, 0), '#pragma once\n\n');
        if (guard) {
            b.delete(new vscode.Range(guard.ifndefLine, 0, guard.defineLine + 1, 0));
            b.delete(new vscode.Range(guard.endifLine, 0, guard.endifLine, doc.lineAt(guard.endifLine).text.length));
        }
    });
    vscode.window.setStatusBarMessage('Вставлен #pragma once', 2500);
    updateStatusBarForDoc(doc);
}

async function toggleGuardOrPragma(ed: vscode.TextEditor) {
    const doc = ed.document;
    if (!isHeader(doc)) return vscode.window.showWarningMessage('Откройте .h/.hpp/.hh/.hxx файл.');
    if (hasPragmaOnce(doc)) {
        const macro = computeMacro(doc);
        await ed.edit(b => {
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
                if (line.trim()) break;
            }
            b.insert(new vscode.Position(0, 0), `#ifndef ${macro}\n#define ${macro}\n\n`);
            b.insert(new vscode.Position(doc.lineCount, 0), `\n#endif // ${macro}\n`);
        });
        vscode.window.setStatusBarMessage('Заменили #pragma once на include guard.', 2500);
    } else {
        const guard = extractGuardMacro(doc);
        if (guard) {
            await ed.edit(b => {
                b.insert(new vscode.Position(0, 0), '#pragma once\n\n');
                b.delete(new vscode.Range(guard.ifndefLine, 0, guard.defineLine + 1, 0));
                b.delete(new vscode.Range(guard.endifLine, 0, guard.endifLine, doc.lineAt(guard.endifLine).text.length));
            });
            vscode.window.setStatusBarMessage('Заменили include guard на #pragma once.', 2500);
        } else {
            await insertGuard(ed);
        }
    }
    updateStatusBarForDoc(doc);
}

function updateStatusBarForDoc(doc?: vscode.TextDocument) {
    if (!doc || !isHeader(doc)) return statusItem.hide();
    const state = hasPragmaOnce(doc) ? 'pragma once' : (extractGuardMacro(doc) ? 'include guard' : 'нет');
    statusItem.text = `${state}`;
    statusItem.tooltip = 'Щёлкните, чтобы переключить защиту заголовка';
    statusItem.show();
}