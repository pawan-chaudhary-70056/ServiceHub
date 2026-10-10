/*
  Warnings:

  - You are about to drop the column `content` on the `report_exports` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "report_exports" DROP COLUMN "content",
ADD COLUMN     "storage_key" TEXT;
