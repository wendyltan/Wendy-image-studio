import { useCallback, useMemo, useState } from 'react';
import {
  studioApi,
  type AssetAnalysisKind,
  type ManualAssetSaveResult,
} from './api';
import type {
  Asset,
  AssetCandidate,
  Bootstrap,
  Project,
  Proposal,
  StagedAssetCandidate,
} from './types';
import type { StudioStatus } from './use-project-controller';

type AssetsControllerOptions = {
  status: StudioStatus;
  data: Bootstrap | null;
  project: Project | null;
  model: string;
  updateData: (updater: (value: Bootstrap | null) => Bootstrap | null) => void;
  refresh: () => Promise<void>;
};

export function useAssetsController({
  status,
  data,
  project,
  model,
  updateData,
  refresh,
}: AssetsControllerOptions) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [applyWorld, setApplyWorld] = useState(false);
  const [applyWorkflow, setApplyWorkflow] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [manualCandidate, setManualCandidate] = useState<AssetCandidate | null>(
    null,
  );
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [manualCategory, setManualCategory] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualTags, setManualTags] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [manualUsage, setManualUsage] = useState<
    '本篇' | '常用参考' | '正式基线'
  >('常用参考');
  const [assetSearch, setAssetSearch] = useState('');
  const [assetCategoryFilter, setAssetCategoryFilter] = useState('');
  const [assetUsageFilter, setAssetUsageFilter] = useState('');
  const [assetResults, setAssetResults] = useState<Asset[] | null>(null);
  const [assetGroup, setAssetGroup] = useState('人物与服装');

  const assets = useMemo(
    () =>
      (assetResults || data?.assets || []).filter(
        (asset) => asset.group === assetGroup,
      ),
    [assetGroup, assetResults, data],
  );

  const analyze = useCallback(
    async (kind: AssetAnalysisKind, key: string | number) => {
      if (!project) return;
      status.setWaiting(true);
      try {
        setProposal(
          (await studioApi.analyzeAsset(project.id, kind, key, model)).proposal,
        );
      } catch (error) {
        status.setError((error as Error).message);
      } finally {
        status.setWaiting(false);
      }
    },
    [model, project, status],
  );

  const readImageFile = useCallback(async (file: File) => {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('无法读取图片'));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  const upload = useCallback(
    async (file: File) => {
      if (file.size > 20_000_000) {
        status.setError('图片不能超过 20MB。');
        return;
      }
      status.setWaiting(true);
      try {
        setProposal(
          (
            await studioApi.uploadAsset({
              name: file.name,
              type: file.type,
              data: await readImageFile(file),
              model,
            })
          ).proposal,
        );
        setUploadOpen(false);
      } catch (error) {
        status.setError((error as Error).message);
      } finally {
        status.setWaiting(false);
      }
    },
    [model, readImageFile, status],
  );

  const stageManualAsset = useCallback(
    async (file: File) => {
      if (file.size > 20_000_000) {
        status.setError('图片不能超过 20MB。');
        return;
      }
      status.setWaiting(true);
      try {
        const result: { candidate: StagedAssetCandidate } =
          await studioApi.stageAsset({
            name: file.name,
            type: file.type,
            data: await readImageFile(file),
          });
        const candidate = {
          ...result.candidate.inspection,
          id: result.candidate.id,
          name: result.candidate.name,
        };
        setManualFile(file);
        setManualCandidate(candidate);
        setManualName(file.name.replace(/\.(png|jpe?g|webp)$/i, ''));
        setManualCategory(
          (category) => category || data?.categories[0]?.id || '',
        );
        setManualTags('');
        setManualDescription('');
        if (candidate.duplicate)
          status.setToast('这张图已在素材库中，已显示已有素材位置。');
      } catch (error) {
        status.setError((error as Error).message);
      } finally {
        status.setWaiting(false);
      }
    },
    [data, readImageFile, status],
  );

  const inspectManualAsset = useCallback(async () => {
    if (!manualCandidate) return;
    status.setWaiting(true);
    try {
      const result = await studioApi.candidate(manualCandidate.id);
      setManualCandidate(result.candidate);
      status.setToast(
        result.candidate.duplicate
          ? '已找到相同素材，不会重复保存。'
          : '本地检查完成，可以填写入库信息。',
      );
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [manualCandidate, status]);

  const closeManualUpload = useCallback(() => {
    setUploadOpen(false);
    setManualCandidate(null);
    setManualFile(null);
  }, []);

  const saveManualAsset = useCallback(async () => {
    if (!manualCandidate || manualCandidate.duplicate) return;
    status.setWaiting(true);
    try {
      const result: ManualAssetSaveResult = await studioApi.saveManualAsset({
        candidateId: manualCandidate.id,
        category: manualCategory,
        name: manualName,
        tags: manualTags
          .split(/[，,]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        description: manualDescription,
        usage: manualUsage,
      });
      if (result.assets)
        updateData((value) =>
          value ? { ...value, assets: result.assets || value.assets } : value,
        );
      if (result.duplicate) {
        setManualCandidate((candidate) =>
          candidate
            ? {
                ...candidate,
                duplicate: result.asset
                  ? { file: result.asset.file, asset: result.asset }
                  : candidate.duplicate,
              }
            : candidate,
        );
        status.setToast('这张图已在素材库中，未重复保存。');
        return;
      }
      status.setToast('素材已按你的分类加入素材库，未调用模型。');
      closeManualUpload();
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [
    closeManualUpload,
    manualCandidate,
    manualCategory,
    manualDescription,
    manualName,
    manualTags,
    manualUsage,
    status,
    updateData,
  ]);

  const searchLibraryAssets = useCallback(async () => {
    status.setWaiting(true);
    try {
      const params = new URLSearchParams();
      if (assetSearch.trim()) params.set('query', assetSearch.trim());
      if (assetCategoryFilter) params.set('category', assetCategoryFilter);
      if (assetUsageFilter) params.set('usage', assetUsageFilter);
      const result = await studioApi.searchAssets(params.toString());
      setAssetResults(result.assets);
      status.setToast(`本地找到 ${result.total} 项素材。`);
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [assetCategoryFilter, assetSearch, assetUsageFilter, status]);

  const clearAssetSearch = useCallback(() => {
    setAssetSearch('');
    setAssetCategoryFilter('');
    setAssetUsageFilter('');
    setAssetResults(null);
  }, []);

  const applyProposal = useCallback(async () => {
    if (!proposal) return;
    status.setWaiting(true);
    try {
      const result = await studioApi.applyProposal(
        proposal.id,
        applyWorld,
        applyWorkflow,
      );
      setProposal(null);
      status.setToast(
        result.duplicate
          ? '这张图已在长期素材库中，未重复添加。'
          : '素材已加入长期素材库。',
      );
      await refresh();
    } catch (error) {
      status.setError((error as Error).message);
    } finally {
      status.setWaiting(false);
    }
  }, [applyWorkflow, applyWorld, proposal, refresh, status]);

  return {
    proposal,
    setProposal,
    applyWorld,
    setApplyWorld,
    applyWorkflow,
    setApplyWorkflow,
    uploadOpen,
    setUploadOpen,
    manualCandidate,
    manualFile,
    manualCategory,
    setManualCategory,
    manualName,
    setManualName,
    manualTags,
    setManualTags,
    manualDescription,
    setManualDescription,
    manualUsage,
    setManualUsage,
    assetSearch,
    setAssetSearch,
    assetCategoryFilter,
    setAssetCategoryFilter,
    assetUsageFilter,
    setAssetUsageFilter,
    assetResults,
    assetGroup,
    setAssetGroup,
    assets,
    analyze,
    upload,
    stageManualAsset,
    inspectManualAsset,
    closeManualUpload,
    saveManualAsset,
    searchLibraryAssets,
    clearAssetSearch,
    applyProposal,
  };
}
