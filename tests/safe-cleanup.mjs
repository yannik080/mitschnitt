import fs from 'node:fs';
import path from 'node:path';

/**
 * Löscht ein Testverzeichnis — aber niemals eines, das ein Mensch benutzt.
 *
 * Diese Wache existiert, weil genau das schon einmal schiefgegangen ist:
 * eine Aufräumzeile hat den voreingestellten Zielordner gelöscht und damit
 * echte Downloads mitgenommen. Testpfade tragen seither eine Kennzeichnung
 * im Namen, und alles ohne diese Kennzeichnung bleibt unangetastet.
 */
export function removeTestDir(absolutePath) {
  const name = path.basename(absolutePath);
  const looksLikeTest = /(-E2E|-Visualtest|-ResumeTest|-Diag|-Test)$/i.test(name);
  if (!looksLikeTest) {
    throw new Error(
      `Verweigert: "${absolutePath}" sieht nicht nach einem Testordner aus. ` +
      'Testordner tragen eine Endung wie -E2E oder -Visualtest.');
  }
  fs.rmSync(absolutePath, { recursive: true, force: true });
}
