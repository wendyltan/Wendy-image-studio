import { Save, Sparkles } from 'lucide-react';
import type { Doc } from './types';
import { Dialog, type DialogSet } from './dialog';

export function DocumentDialog({
  doc,
  setDoc,
  docText,
  setDocText,
  suggestNote,
  setSuggestNote,
  suggestDoc,
  saveDoc,
}: {
  doc: Doc | null;
  setDoc: DialogSet<Doc | null>;
  docText: string;
  setDocText: DialogSet<string>;
  suggestNote: string;
  setSuggestNote: DialogSet<string>;
  suggestDoc: () => void | Promise<void>;
  saveDoc: () => void | Promise<void>;
}) {
  if (!doc) return null;
  return (
    <Dialog wide close={() => setDoc(null)}>
      <h2>{doc.label}</h2>
      <p>
        可以直接编辑，也可以让创作助手先给出完整修订建议；保存时自动备份旧版。
      </p>
      <div className="suggest-row">
        <textarea
          value={suggestNote}
          onChange={(event) => setSuggestNote(event.target.value)}
          placeholder="想完善什么？"
        />
        <button className="secondary" onClick={suggestDoc}>
          <Sparkles />
          智能完善
        </button>
      </div>
      <textarea
        className="doc-editor"
        value={docText}
        onChange={(event) => setDocText(event.target.value)}
      />
      <button className="primary" onClick={saveDoc}>
        <Save />
        检查后保存长期设定
      </button>
    </Dialog>
  );
}
