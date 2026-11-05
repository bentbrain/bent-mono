-- Read-only inventory for issues #396 and #398. No customer/order identifiers.
SELECT p.id,p.design_id,p.design_revision_id,p.base_product_id,p.status,
  p.default_color,p.placement_x,p.placement_y,p.placement_width,p.placement_depth,
  p.projection_version,r.artwork_key,r.content_type,r.byte_size,
  r.artwork_width,r.artwork_height,r.sha256,r.crop_x,r.crop_y,r.crop_zoom
FROM products p JOIN design_revisions r ON r.id=p.design_revision_id
WHERE p.id IN ('d09442a5-74b9-43a7-9ec3-e14231dd7b07','ca2029bf-d870-4d81-97f8-8edbdc6352c7','3d8ed467-55d4-45ed-ba9d-1eeb687fa5bc','415079cb-db44-48c7-a2eb-707befc01bdb') ORDER BY p.id;

SELECT p.id,p.design_id,p.design_revision_id,p.base_product_id,p.status,
  p.default_color,p.placement_depth,
  (SELECT count(*) FROM paid_order_lines line WHERE line.configured_product_id=p.id) AS paid_order_line_count,
  (SELECT json_group_array(json_object('colour',j.colour,'status',j.status,
    'rendererVersion',j.renderer_version,'storyKey',j.story_key,'attemptCount',j.attempt_count))
    FROM story_video_jobs j WHERE j.product_id=p.id AND j.renderer_version='story-video-renderer-v7') AS videos
FROM products p WHERE p.design_id IN (
  SELECT design_id FROM products WHERE id IN ('d09442a5-74b9-43a7-9ec3-e14231dd7b07','ca2029bf-d870-4d81-97f8-8edbdc6352c7','3d8ed467-55d4-45ed-ba9d-1eeb687fa5bc','415079cb-db44-48c7-a2eb-707befc01bdb')
) ORDER BY p.design_id,p.base_product_id;

SELECT revision FROM featured_product_state WHERE id=1;
SELECT slot,product_id FROM featured_products ORDER BY slot;
