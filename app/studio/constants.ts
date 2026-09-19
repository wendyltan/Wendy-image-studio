export const statuses: Record<string, string> = {
  draft: '已保存',
  planning: '构思中',
  review: '待确认方案',
  sampling: '绘制样张',
  samples_review: '待确认样张',
  samples_decision: '等你决定样张',
  generating: '绘制中',
  revising: '修改中',
  paused: '已暂停',
  attention: '需要查看',
  ready: '待收下成品',
  complete: '已完成',
};

export const layouts: Record<string, string> = {
  solo: '全页主画面',
  duo: '上主格 · 下副格',
  trio: '主画面 + 两个细节',
  montage: '三段时间蒙太奇',
  four: '主画面 + 三个细节',
};

export const effortLabels: Record<string, string> = {
  none: '无',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最大',
  ultra: '极致',
};

export const presets: Record<string, { name: string; note: string }> = {
  quick: { name: '快速', note: '逐页检查，省时省额度' },
  balanced: { name: '均衡', note: '逐页 + 全篇检查（推荐）' },
  careful: { name: '精细', note: '每格 + 每页 + 全篇检查' },
};
