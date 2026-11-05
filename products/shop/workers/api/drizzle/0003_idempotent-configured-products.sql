UPDATE `products` AS `duplicate`
SET
	`status` = 'deleted',
	`deleted_at` = unixepoch() * 1000
WHERE
	`duplicate`.`status` = 'active'
	AND `duplicate`.`design_id` IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM `products` AS `original`
		WHERE
			`original`.`status` = 'active'
			AND `original`.`design_id` = `duplicate`.`design_id`
			AND (
				`original`.`created_at` < `duplicate`.`created_at`
				OR (
					`original`.`created_at` = `duplicate`.`created_at`
					AND `original`.`id` < `duplicate`.`id`
				)
			)
	);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_active_design_unique_idx` ON `products` (`design_id`) WHERE "products"."design_id" IS NOT NULL AND "products"."status" = 'active';
