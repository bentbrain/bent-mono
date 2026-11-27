import { SymbolView as ExpoSymbolView } from "expo-symbols";
import type { SymbolViewProps } from "expo-symbols";
import { withUniwind } from "uniwind";

export type { SFSymbol } from "expo-symbols";

/**
 * An SF Symbol. Colour it with a token through `tintColorClassName`, such
 * as `accent-icon` or `accent-primary`.
 */
export const Symbol = withUniwind((props: SymbolViewProps) => <ExpoSymbolView type="monochrome" {...props} />);
