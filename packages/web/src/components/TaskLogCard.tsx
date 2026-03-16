import { fmtTime } from '../lib/format';
import type { TaskItem } from '../lib/types';
import ReactMarkdown from 'react-markdown';

interface TaskLogCardProps {
  tasks: TaskItem[];
}

/**
 * 将标准 Markdown 转换为飞书 Card 兼容格式
 * - 表格 → 列表格式
 * - # ## ### 标题 → 加粗文本
 * - 保留 #### ##### 标题
 */
function convertToFeishuCardMarkdown(text: string): string {
  let result = text;

  // 转换表格为列表格式
  // 匹配 Markdown 表格:
  // | 列1 | 列2 |
  // |-----|-----|
  // | 值1 | 值2 |
  const tableRegex = /\|(.+)\|\n\|[-:| ]+\|\n((?:\|.+\|\n?)+)/g;
  result = result.replace(tableRegex, (_, headerRow, bodyRows) => {
    const headers = headerRow.split('|').map((h: string) => h.trim()).filter(Boolean);
    const rows = bodyRows.trim().split('\n').map((row: string) => 
      row.split('|').map((cell: string) => cell.trim()).filter(Boolean)
    );
    
    let output = '';
    rows.forEach((row: string[]) => {
      row.forEach((cell: string, index: number) => {
        const header = headers[index] || '';
        output += `- **${header}**: ${cell}\n`;
      });
    });
    return output;
  });

  // 转换 # ## ### 标题为加粗文本
  result = result.replace(/^### (.+)$/gm, '**$1**');
  result = result.replace(/^## (.+)$/gm, '**$1**');
  result = result.replace(/^# (.+)$/gm, '**$1**');

  return result;
}

export function TaskLogCard({ tasks }: TaskLogCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-icon">📋</span>
        <span className="card-title">TASK LOG</span>
      </div>
      <div className="card-body">
        <div className="task-log">
          {tasks.length === 0 ? (
            <div className="empty">暂无任务记录</div>
          ) : (
            tasks.map((t) => <TaskRow key={t.sessionFile + t.startedAt} task={t} />)
          )}
        </div>
      </div>
    </div>
  );
}

function TaskRow({ task: t }: { task: TaskItem }) {
  const now = Date.now();
  const elapsed = now - new Date(t.lastActivityAt).getTime();
  const isActive = elapsed < 15 * 60 * 1000;
  const isRecent = elapsed < 2 * 3600 * 1000;

  const statusClass = isActive ? 'task-active' : isRecent ? 'task-recent' : 'task-done';
  const statusLabel = isActive ? '进行中' : isRecent ? '刚完成' : '已完成';

  // 转换 Markdown 为飞书 Card 兼容格式
  const taskMarkdown = convertToFeishuCardMarkdown(t.task);
  const resultMarkdown = t.result ? convertToFeishuCardMarkdown(t.result) : null;

  return (
    <div className={`task-item ${statusClass}`}>
      <div className="task-header">
        <span className="task-time">{fmtTime(t.startedAt)}</span>
        {t.toolCount > 0 && <span className="task-tools">🔧 {t.toolCount}</span>}
        <span className="task-status">{statusLabel}</span>
      </div>
      <div className="task-desc markdown-content">
        <ReactMarkdown>{taskMarkdown}</ReactMarkdown>
      </div>
      {resultMarkdown && (
        <div className="task-result markdown-content">
          <span className="result-arrow">→</span>
          <ReactMarkdown>{resultMarkdown}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
