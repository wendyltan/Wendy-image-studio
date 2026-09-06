import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: '温蒂的日常 · 创作室',
  description: '把日常的小小心事，画成一篇温蒂的故事。',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
