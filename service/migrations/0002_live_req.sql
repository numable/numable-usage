-- 手机上点「在电脑上打开实时会话」的时刻(doc/ccusage-live-timeline.md §10)。
-- 电脑下一次 /ingest 时在回包里带回(liveReq),插件 0.10.0+ 据此打开实时会话 + 同步(只开 L1)。
ALTER TABLE spaces ADD COLUMN live_req_at INTEGER;
