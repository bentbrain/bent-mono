ALTER TABLE `designs` ADD COLUMN `safety_screening_decision` text
  CHECK (`safety_screening_decision` IS NULL OR `safety_screening_decision` = 'allowed');
--> statement-breakpoint
ALTER TABLE `designs` ADD COLUMN `safety_screening_model` text;
