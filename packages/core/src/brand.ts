/**
 * The ONE place the product name lives. Renaming (e.g. BrianHarness -> BrainHarness) = edit
 * brand.json: the window title, sidebar wordmark, sim banner, electron-builder productName and
 * appId all read it. `dataDirName` is deliberately separate and should NOT change on a rename,
 * so existing save files / credentials in ~/Library/Application Support/<dataDirName> keep working.
 * (npm package names @brianharness/* are internal and don't need to follow a rename.)
 */
import brand from "./brand.json" with { type: "json" };

export interface Brand {
  name: string;
  slug: string;
  appId: string;
  dataDirName: string;
  tagline: string;
}
export const BRAND: Brand = brand;
export const APP_NAME = BRAND.name;
