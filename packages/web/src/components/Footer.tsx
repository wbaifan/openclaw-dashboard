import { memo, useState, useEffect, useRef } from 'react';
import type { WsStatus } from '../hooks/useMetrics';

interface FooterProps {
  timestamp?: number;
  wsStatus: WsStatus;
}

const STORAGE_KEY = 'openclaw-dashboard-name';
const STORAGE_KEY_EMOJI = 'openclaw-dashboard-emoji';
const DEFAULT_NAME = 'OpenClaw';
const DEFAULT_EMOJI = '🦐';

// 常用 emoji 列表
const EMOJI_LIST = [
  '🦐', '🌟', '⭐', '🔥', '💫', '✨', '🌙', '☀️',
  '🦀', '🦞', '🐙', '🦑', '🐬', '🐳', '🐋', '🦈',
  '🤖', '🧚‍♂️', '🧚‍♀️', '🦸', '🦹', '👨‍💻', '👩‍💻', '🧙',
  '🎨', '🎯', '🎲', '🎮', '🎬', '🎧', '🎹', '🎸',
  '🚀', '✈️', '🛸', '🛰️', '🌍', '🌎', '🌏', '🌐',
  '💡', '📱', '💻', '🖥️', '⚡', '🔌', '🔋', '🔮',
  '🌸', '🌺', '🌻', '🌼', '🍀', '🌲', '🌴', '🌵',
  '🎉', '🎊', '🎁', '🎈', '🎀', '🏆', '🥇', '🎖️'
];

// 相对时间格式化函数
const getRelativeTime = (ts: number): string => {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return '刚刚';
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  return `${Math.floor(diff / 3600)}小时前`;
};

export const Footer = memo(function Footer({ timestamp, wsStatus }: FooterProps) {
  // Force re-render every second to update time display
  const [, setTick] = useState(0);
  
  // 名字和emoji状态
  const [name, setName] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved || DEFAULT_NAME;
    }
    return DEFAULT_NAME;
  });
  
  const [emoji, setEmoji] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY_EMOJI);
      return saved || DEFAULT_EMOJI;
    }
    return DEFAULT_EMOJI;
  });
  
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Update every second for "ticking" time
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // 点击外部关闭 emoji 选择器
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setShowEmojiPicker(false);
      }
    };

    if (showEmojiPicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showEmojiPicker]);

  // 自动聚焦输入框
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const updated = timestamp
    ? '更新于: ' + getRelativeTime(timestamp)
    : '更新于: --';

  const wsColor =
    wsStatus === 'live'
      ? 'var(--green)'
      : wsStatus === 'connecting'
        ? 'var(--text2)'
        : 'var(--red)';

  // 开始编辑名字
  const handleStartEdit = () => {
    setEditValue(name);
    setIsEditing(true);
  };

  // 保存编辑
  const handleSave = () => {
    const trimmed = editValue.trim();
    if (trimmed) {
      setName(trimmed);
      localStorage.setItem(STORAGE_KEY, trimmed);
    }
    setIsEditing(false);
  };

  // 取消编辑
  const handleCancel = () => {
    setEditValue(name);
    setIsEditing(false);
  };

  // 键盘事件处理
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  // 选择 emoji
  const handleEmojiSelect = (selectedEmoji: string) => {
    setEmoji(selectedEmoji);
    localStorage.setItem(STORAGE_KEY_EMOJI, selectedEmoji);
    setShowEmojiPicker(false);
  };

  // 点击 emoji 图标（非编辑模式）
  const handleEmojiClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止冒泡，不触发名字编辑
    setShowEmojiPicker(!showEmojiPicker);
  };

  return (
    <footer className="footer">
      <div className="footer-name-container">
        {isEditing ? (
          <span className="footer-name-edit">
            <span 
              className="footer-emoji-picker-trigger"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              title="点击更换图标"
            >
              {emoji}
            </span>
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSave}
              placeholder="输入名字"
              maxLength={20}
              className="footer-name-input"
            />
            <span>Dashboard</span>
            {showEmojiPicker && (
              <div ref={emojiPickerRef} className="emoji-picker">
                <div className="emoji-picker-grid">
                  {EMOJI_LIST.map((e, i) => (
                    <button
                      key={i}
                      className="emoji-picker-item"
                      onClick={() => handleEmojiSelect(e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </span>
        ) : (
          <span className="footer-name-wrapper">
            <span 
              className="footer-emoji-display"
              onClick={handleEmojiClick}
              title="点击更换图标"
            >
              {emoji}
            </span>
            {showEmojiPicker && (
              <div ref={emojiPickerRef} className="emoji-picker">
                <div className="emoji-picker-grid">
                  {EMOJI_LIST.map((e, i) => (
                    <button
                      key={i}
                      className="emoji-picker-item"
                      onClick={() => handleEmojiSelect(e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <span 
              className="footer-name" 
              onClick={handleStartEdit}
              title="点击修改名字"
            >
              {name} Dashboard
            </span>
          </span>
        )}
      </div>
      <span>{updated}</span>
      <span style={{ color: wsColor }}>WS: {wsStatus === 'live' ? 'live' : wsStatus === 'connecting' ? 'connecting...' : 'offline'}</span>
    </footer>
  );
});
