CREATE INDEX designs_owner_finalized_idx ON designs(owner_id, finalized_at DESC, id DESC)
  WHERE finalized_at IS NOT NULL AND deleted_at IS NULL AND status = 'ready';
