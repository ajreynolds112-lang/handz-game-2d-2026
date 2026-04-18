import { FighterColors, COLOR_PRESETS } from "@/game/types";
import { Card } from "@/components/ui/card";

interface ColorPickerProps {
  colors: FighterColors;
  onChange: (colors: FighterColors) => void;
}

function SwatchRow({ label, selected, options, onSelect, testId }: {
  label: string;
  selected: string;
  options: string[];
  onSelect: (color: string) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-16 text-right shrink-0">{label}</span>
      <div className="flex gap-1.5 flex-wrap">
        {options.map(c => (
          <button
            key={c}
            className={`w-6 h-6 rounded-md cursor-pointer transition-all ${
              selected === c ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
            }`}
            style={{ backgroundColor: c }}
            onClick={() => onSelect(c)}
            data-testid={`${testId}-${c}`}
          />
        ))}
      </div>
    </div>
  );
}

export default function ColorPicker({ colors, onChange }: ColorPickerProps) {
  return (
    <Card className="p-4 w-full">
      <h3 className="text-sm font-semibold mb-3 text-center text-muted-foreground">CUSTOMIZE GEAR</h3>
      <div className="space-y-3">
        <SwatchRow
          label="Gloves"
          selected={colors.gloves}
          options={COLOR_PRESETS.gloves}
          onSelect={c => onChange({ ...colors, gloves: c })}
          testId="swatch-gloves"
        />
        <SwatchRow
          label="Tape"
          selected={colors.gloveTape}
          options={COLOR_PRESETS.gloveTape}
          onSelect={c => onChange({ ...colors, gloveTape: c })}
          testId="swatch-tape"
        />
        <SwatchRow
          label="Trunks"
          selected={colors.trunks}
          options={COLOR_PRESETS.trunks}
          onSelect={c => onChange({ ...colors, trunks: c })}
          testId="swatch-trunks"
        />
        <SwatchRow
          label="Shoes"
          selected={colors.shoes}
          options={COLOR_PRESETS.shoes}
          onSelect={c => onChange({ ...colors, shoes: c })}
          testId="swatch-shoes"
        />
      </div>

      <div className="mt-3 flex justify-center">
        <div className="relative w-24 h-28">
          <FighterPreview colors={colors} />
        </div>
      </div>
    </Card>
  );
}

export function FighterPreview({ colors }: { colors: FighterColors }) {
  const skin = colors.skin || "#e8c4a0";
  return (
    <svg viewBox="0 0 80 100" className="w-full h-full">
      <ellipse cx="40" cy="30" rx="8" ry="10" fill={skin} />
      <rect x="30" y="40" width="20" height="25" rx="3" fill={skin} />
      <rect x="32" y="55" width="16" height="14" rx="2" fill={colors.trunks} />
      <line x1="36" y1="69" x2="33" y2="88" stroke={skin} strokeWidth="4" strokeLinecap="round" />
      <line x1="44" y1="69" x2="47" y2="88" stroke={skin} strokeWidth="4" strokeLinecap="round" />
      <rect x="29" y="86" width="8" height="5" rx="2" fill={colors.shoes} />
      <rect x="43" y="86" width="8" height="5" rx="2" fill={colors.shoes} />
      <line x1="30" y1="45" x2="18" y2="55" stroke={skin} strokeWidth="3" strokeLinecap="round" />
      <line x1="50" y1="45" x2="62" y2="50" stroke={skin} strokeWidth="3" strokeLinecap="round" />
      <circle cx="16" cy="57" r="5" fill={colors.gloves} />
      <circle cx="64" cy="52" r="5" fill={colors.gloves} />
      <path d="M 14 61 Q 16 63 18 61" stroke={colors.gloveTape} strokeWidth="1.5" fill="none" />
      <path d="M 62 56 Q 64 58 66 56" stroke={colors.gloveTape} strokeWidth="1.5" fill="none" />
    </svg>
  );
}
