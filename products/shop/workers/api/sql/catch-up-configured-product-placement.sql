-- Repeat after the compatible Worker is live to cover products written by the
-- previous Worker between migration 0011 and deployment.
UPDATE `products`
SET
  `placement_x` = COALESCE(
    `placement_x`,
    (SELECT `placement_x` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`),
    (SELECT `placement_x` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`)
  ),
  `placement_y` = COALESCE(
    `placement_y`,
    (SELECT `placement_y` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`),
    (SELECT `placement_y` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`)
  ),
  `placement_width` = COALESCE(
    `placement_width`,
    (SELECT `placement_width` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`),
    (SELECT `placement_width` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`)
  ),
  `placement_depth` = COALESCE(
    `placement_depth`,
    (SELECT `depth` FROM `design_revisions` WHERE `design_revisions`.`id` = `products`.`design_revision_id`),
    (SELECT `depth` FROM `designs` WHERE `designs`.`id` = `products`.`design_id`)
  )
WHERE
  `design_id` IS NOT NULL
  AND (
    `placement_x` IS NULL OR `placement_y` IS NULL OR
    `placement_width` IS NULL OR `placement_depth` IS NULL
  );
