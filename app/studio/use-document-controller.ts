import { useCallback, useState } from 'react';
import type { Doc } from './types';
import { studioApi } from './api';
import type { StudioStatus } from './use-project-controller';

type DocumentControllerOptions = {
  status: StudioStatus;
  model: string;
  effort: string;
  refresh: () => Promise<void>;
};

export function useDocumentController({
  status,
  model,
  effort,
  refresh,
}: DocumentControllerOptions) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [docText, setDocText] = useState('');
  const [suggestNote, setSuggestNote] = useState('');

  const suggestDoc = useCallback(async () => {
    if (!doc) return;
    status.setWaiting(true);
    try {
      const result = await studioApi.suggestDocument({
        docPath: doc.path,
        note: suggestNote,
        model,
        reasoningEffort: effort,
      });
      setDocText(result.revisedText);
      status.setToast('修改建议已填入编辑区，请检查后保存。');
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [doc, effort, model, status, suggestNote]);

  const saveDoc = useCallback(async () => {
    if (
      !doc ||
      !window.confirm('保存后会更新长期设定，并自动保留旧版本。确定保存吗？')
    )
      return;
    status.setWaiting(true);
    try {
      await studioApi.saveDocument({
        docPath: doc.path,
        content: docText,
        expectedHash: doc.hash,
      });
      setDoc(null);
      status.setToast('长期设定已保存，旧版本已备份。');
      await refresh();
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [doc, docText, refresh, status]);

  const openDoc = useCallback((next: Doc) => {
    setDoc(next);
    setDocText(next.text);
    setSuggestNote('');
  }, []);

  return {
    doc,
    setDoc,
    docText,
    setDocText,
    suggestNote,
    setSuggestNote,
    openDoc,
    suggestDoc,
    saveDoc,
  };
}
