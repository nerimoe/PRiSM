import { useId, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { OperatingMode } from "./setup-guide";
import type { TourDiagramId } from "./setup-tour";

const tagText = "fill-current text-[10.5px] font-semibold text-ink";
const subText = "fill-current text-[9.5px] text-ink/55";
const mintText = "fill-current text-[10.5px] font-semibold text-mint";
const tourText = "fill-current text-[10.5px] font-semibold text-tour";

/**
 * Pictorial vector illustrations for the setup guide gallery and interactive
 * tour coachmarks: visual floorplans, hardware silhouettes, curves, and UI
 * miniatures with short 2–5 character labels instead of text boxes.
 */
export function GuideDiagram({
  id,
  mode = "self",
  compact = false,
  wide = false,
}: {
  id: TourDiagramId;
  mode?: OperatingMode;
  compact?: boolean;
  wide?: boolean;
}) {
  const frameClass = compact
    ? "overflow-hidden rounded-xl border border-ink/10 bg-ink/[0.025] p-2"
    : "overflow-x-auto rounded-xl border border-ink/10 bg-ink/[0.02] p-3";
  return (
    <div className={frameClass}>
      {id === "store-hierarchy" && <StoreHierarchyDiagram mode={mode} />}
      {id === "store-example-override" && <StoreSingleOverrideDiagram />}
      {id === "store-example-zone" && <StoreMultiZoneDiagram />}
      {id === "resource-abilities" && <ResourceAbilitiesDiagram wide={wide && !compact} />}
      {id === "pricing-workbench" && <PricingWorkbenchDiagram />}
      {id === "identity-bot" && <IdentityBotDiagram />}
      {id === "money-flow" && <MoneyFlowDiagram mode={mode} />}
      {id === "cashier-flow" && <CashierFlowDiagram />}
      {id === "qr-nfc-entry" && <QrNfcEntryDiagram mode={mode} />}
      {id === "ttlock-door" && <TTLockDoorDiagram />}
      {id === "daily-dashboard" && <DailyDashboardDiagram />}
    </div>
  );
}

function ArrowDefs({ id, tone = "text-ink/35" }: { id: string; tone?: string }) {
  return (
    <defs>
      <marker
        id={id}
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 1 2 L 8 5 L 1 8 z" className={`fill-current ${tone}`} />
      </marker>
    </defs>
  );
}

/** Miniature arcade cabinet silhouette (44x62). */
function ArcadeCabinet({ x, y, lit = true }: { x: number; y: number; lit?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {/* Cabinet body */}
      <rect x={2} y={8} width={40} height={52} rx={5} className="fill-panel stroke-ink/25" strokeWidth={1.3} />
      {/* Marquee */}
      <path d="M 4 8 L 40 8 L 37 2 L 7 2 Z" className={lit ? "fill-current text-mint/35 stroke-mint/60" : "fill-current text-ink/10 stroke-ink/25"} strokeWidth={1.1} />
      {/* Screen */}
      <rect x={7} y={13} width={30} height={19} rx={3} className={lit ? "fill-current text-mint/20 stroke-mint/70" : "fill-current text-ink/[0.06] stroke-ink/20"} strokeWidth={1.2} />
      {lit && <path d="M 11 26 L 18 19 L 23 23 L 32 16" fill="none" strokeWidth={1.5} strokeLinecap="round" className="stroke-current text-mint" />}
      {/* Control deck: joystick + 2 buttons */}
      <line x1={5} y1={36} x2={39} y2={36} className="stroke-current text-ink/20" strokeWidth={1.2} />
      <line x1={14} y1={36} x2={14} y2={32} className="stroke-current text-ink/60" strokeWidth={1.4} />
      <circle cx={14} cy={31} r={2.2} className="fill-current text-coral" />
      <circle cx={26} cy={34} r={1.8} className="fill-current text-mint" />
      <circle cx={32} cy={33} r={1.8} className="fill-current text-tour" />
      {/* Coin door */}
      <rect x={15} y={42} width={14} height={13} rx={2} className="fill-current text-ink/[0.05] stroke-ink/20" strokeWidth={1} />
      <line x1={22} y1={45} x2={22} y2={50} className="stroke-current text-tour" strokeWidth={1.5} strokeLinecap="round" />
    </g>
  );
}

/** Crisp miniature QR finder matrix (22x22). */
function QrMini({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={0} y={0} width={22} height={22} rx={4} className="fill-panel stroke-ink/25" strokeWidth={1.1} />
      <rect x={3} y={3} width={6} height={6} rx={1} fill="none" className="stroke-current text-ink/80" strokeWidth={1.4} />
      <rect x={13} y={3} width={6} height={6} rx={1} fill="none" className="stroke-current text-ink/80" strokeWidth={1.4} />
      <rect x={3} y={13} width={6} height={6} rx={1} fill="none" className="stroke-current text-ink/80" strokeWidth={1.4} />
      <rect x={13} y={13} width={2.5} height={2.5} className="fill-current text-mint" />
      <rect x={16.5} y={16.5} width={2.5} height={2.5} className="fill-current text-ink/75" />
      <rect x={13} y={16.5} width={2.5} height={2.5} className="fill-current text-ink/75" />
    </g>
  );
}

/** Contactless NFC wave arcs. */
function NfcWaves({ x, y, tone = "text-mint" }: { x: number; y: number; tone?: string }) {
  return (
    <g transform={`translate(${x} ${y})`} fill="none" strokeLinecap="round" className={`stroke-current ${tone}`}>
      <path d="M 0 8 A 6 6 0 0 1 0 0" strokeWidth={1.5} />
      <path d="M 4 11 A 10 10 0 0 1 4 -3" strokeWidth={1.5} opacity={0.75} />
      <path d="M 8 14 A 14 14 0 0 1 8 -6" strokeWidth={1.5} opacity={0.45} />
    </g>
  );
}

/** Top-down 4-seat game table with tiles/cards on the felt. */
function TabletopMini({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g transform={`translate(${cx} ${cy})`}>
      {/* 4 chairs */}
      <rect x={-8} y={-30} width={16} height={7} rx={3.5} className="fill-current text-tour/30 stroke-tour" strokeWidth={1.2} />
      <rect x={-8} y={23} width={16} height={7} rx={3.5} className="fill-current text-tour/30 stroke-tour" strokeWidth={1.2} />
      <rect x={-30} y={-8} width={7} height={16} rx={3.5} className="fill-current text-tour/30 stroke-tour" strokeWidth={1.2} />
      <rect x={23} y={-8} width={7} height={16} rx={3.5} className="fill-current text-tour/30 stroke-tour" strokeWidth={1.2} />
      {/* Table & felt */}
      <rect x={-19} y={-19} width={38} height={38} rx={8} className="fill-panel stroke-tour/70" strokeWidth={1.4} />
      <rect x={-13} y={-13} width={26} height={26} rx={4} className="fill-current text-tour/15" />
      {/* Mini game tiles / cards */}
      <g transform="translate(-4 -1) rotate(-12)">
        <rect x={-4.5} y={-6} width={9} height={12} rx={1.8} className="fill-panel stroke-tour" strokeWidth={1.2} />
      </g>
      <g transform="translate(5 1) rotate(14)">
        <rect x={-4.5} y={-6} width={9} height={12} rx={1.8} className="fill-panel stroke-mint" strokeWidth={1.2} />
      </g>
    </g>
  );
}

/** Recognizable wall-mounted split AC with snowflake symbol and cool breeze waves (76x40). */
function SplitAcMini({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={0} y={0} width={76} height={25} rx={6} className="fill-panel stroke-mint/60" strokeWidth={1.3} />
      {/* Louver flap */}
      <path d="M 7 19 H 69 L 65 23.5 H 11 Z" className="fill-current text-mint/15 stroke-mint/40" strokeWidth={1} />
      {/* Snowflake symbol */}
      <g transform="translate(17 10.5)" className="stroke-current text-mint" strokeWidth={1.3} strokeLinecap="round">
        <line x1={0} y1={-5} x2={0} y2={5} />
        <line x1={-4.3} y1={-2.5} x2={4.3} y2={2.5} />
        <line x1={-4.3} y1={2.5} x2={4.3} y2={-2.5} />
      </g>
      <text x={66} y={13.5} textAnchor="end" className="fill-current font-mono text-[9px] font-bold text-mint">26°C</text>
      {/* Cool breeze waves */}
      <path
        d="M 20 28 Q 17 34 22 39 M 38 28 Q 35 34 40 39 M 56 28 Q 53 34 58 39"
        fill="none"
        className="stroke-current text-mint/75"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </g>
  );
}

/** Friendly Bot head icon. */
function BotFace({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <line x1={0} y1={-16} x2={0} y2={-22} className="stroke-current text-mint" strokeWidth={1.6} />
      <circle cx={0} cy={-24} r={2.5} className="fill-current text-mint" />
      <rect x={-16} y={-15} width={32} height={26} rx={8} className="fill-panel stroke-mint/65" strokeWidth={1.5} />
      <circle cx={-6} cy={-4} r={2.5} className="fill-current text-mint" />
      <circle cx={6} cy={-4} r={2.5} className="fill-current text-mint" />
      <path d="M -5 4 Q 0 8 5 4" fill="none" className="stroke-current text-ink/55" strokeWidth={1.4} strokeLinecap="round" />
    </g>
  );
}

/** Miniature maimai round-ring cabinet silhouette (44x58). */
function MaimaiCabinet({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={2} y={7} width={40} height={49} rx={6} className="fill-panel stroke-ink/25" strokeWidth={1.3} />
      <path d="M 5 7 L 39 7 L 36 2 L 8 2 Z" className="fill-current text-mint/35 stroke-mint/60" strokeWidth={1.1} />
      {/* Iconic circular rhythm ring */}
      <circle cx={22} cy={24} r={11.5} className="fill-current text-mint/15 stroke-mint/75" strokeWidth={1.4} />
      <circle cx={22} cy={24} r={6.5} fill="none" className="stroke-current text-mint/45" strokeWidth={1} strokeDasharray="2 2" />
      {/*Coin door */}
      <rect x={15} y={40} width={14} height={11} rx={2} className="fill-current text-ink/[0.05] stroke-ink/20" strokeWidth={1} />
      <line x1={22} y1={43} x2={22} y2={48} className="stroke-current text-tour" strokeWidth={1.5} strokeLinecap="round" />
    </g>
  );
}

/** Example 1 (Real Store "月宫"): Whole-shop unified pass — 1 Default Group holds maimai, Chunithm, Ongeki, Door (+ in-shop AC). */
function StoreHierarchyDiagram({ mode }: { mode: OperatingMode }) {
  const { t } = useI18n();
  const devicesOnly = mode === "devices";
  return (
    <svg viewBox="0 0 540 184" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("店铺、资源组与资源关系图")}>
      {/* Outer store boundary */}
      <rect x={8} y={8} width={414} height={168} rx={14} className="fill-panel stroke-ink/20" strokeWidth={1.2} />

      {/* Single Unified Default Resource Group */}
      <rect x={18} y={18} width={394} height={148} rx={11} className="fill-current text-mint/[0.06] stroke-mint/55" strokeWidth={1.3} strokeDasharray="5 3" />

      {/* Price Tag Pill on the group */}
      <rect x={28} y={25} width={212} height={20} rx={10} className="fill-current text-mint/20" />
      <circle cx={39} cy={35} r={2.6} className="fill-panel stroke-mint" strokeWidth={1.2} />
      <text x={139} y={38.5} textAnchor="middle" className={mintText}>
        {t(devicesOnly ? "默认资源组 · 不计费" : "默认资源组 · ¥4/30分 封顶¥40")}
      </text>

      <rect x={260} y={25} width={142} height={20} rx={10} className="fill-panel stroke-mint/45" strokeWidth={1.1} />
      <text x={331} y={38.5} textAnchor="middle" className={mintText}>
        {t(devicesOnly ? "✓ 纯控设备无需分组" : "✓ 月宫实配：仅 1 个组")}
      </text>

      {/* Real 月宫 lineup: 舞萌DX, 中二节奏-左/右, 音击, 门锁 */}
      <MaimaiCabinet x={34} y={50} />
      <text x={56} y={120} textAnchor="middle" className={tagText}>{t("舞萌DX")}</text>

      <ArcadeCabinet x={114} y={48} lit />
      <text x={136} y={120} textAnchor="middle" className={tagText}>{t("中二 左/右")}</text>

      <ArcadeCabinet x={194} y={48} lit />
      <text x={216} y={120} textAnchor="middle" className={tagText}>{t("音击")}</text>

      <g transform="translate(278 52)">
        <rect x={0} y={0} width={118} height={54} rx={9} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <rect x={14} y={8} width={22} height={38} rx={3} className="fill-current text-mint/15 stroke-mint/60" strokeWidth={1.3} />
        <circle cx={31} cy={27} r={1.6} className="fill-current text-mint" />
        <QrMini x={50} y={16} />
        <NfcWaves x={82} y={23} />
      </g>
      <text x={337} y={120} textAnchor="middle" className={tagText}>{t("门锁（扫码入场）")}</text>

      {/* Clear Player Outcome Strip */}
      <rect x={28} y={130} width={374} height={25} rx={12.5} className="fill-panel stroke-mint/60" strokeWidth={1.3} />
      <circle cx={45} cy={142.5} r={6} className="fill-current text-mint/15 stroke-mint" strokeWidth={1.3} />
      <polyline points="45,139 45,142.5 47.8,144.2" fill="none" className="stroke-current text-mint" strokeWidth={1.3} strokeLinecap="round" />
      <text x={221} y={146} textAnchor="middle" className={mintText}>
        {t(devicesOnly ? "扫码直接开机 / 开门 · 全店不产生计费" : "扫门锁或任一机台入场 → 全店机台通用不重算")}
      </text>

      {/* Right Floating QQ Bot */}
      <path d="M 422 92 C 430 92, 430 92, 438 92" fill="none" strokeDasharray="3 3" className="stroke-current text-mint/60" strokeWidth={1.5} />
      <rect x={438} y={38} width={94} height={108} rx={12} className="fill-panel stroke-ink/20" strokeWidth={1.2} strokeDasharray="4 3" />
      <BotFace cx={485} cy={82} />
      <text x={485} y={118} textAnchor="middle" className={tagText}>QQ Bot</text>
      <text x={485} y={133} textAnchor="middle" className={subText}>{t("群管 · 无二维码")}</text>
    </svg>
  );
}

/** Example 2 ("月宫" + Pre-entry AC / Standalone Table): STILL 1 Default Group — individual items override directly! */
function StoreSingleOverrideDiagram() {
  const { t } = useI18n();
  return (
    <svg viewBox="0 0 540 184" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("月宫单台覆盖示例：提前开空调与独立桌游无需新建资源组")}>
      {/* Still ONE single Default Resource Group box across the whole store */}
      <rect x={10} y={10} width={520} height={164} rx={13} className="fill-current text-mint/[0.05] stroke-mint/55" strokeWidth={1.3} strokeDasharray="5 3" />

      {/* Group header + "Still 1 group" badge */}
      <rect x={22} y={18} width={212} height={20} rx={10} className="fill-current text-mint/20" />
      <circle cx={33} cy={28} r={2.4} className="fill-panel stroke-mint" strokeWidth={1.2} />
      <text x={133} y={31.5} textAnchor="middle" className={mintText}>{t("默认资源组 · ¥4/30分 封顶¥40")}</text>

      <rect x={324} y={18} width={194} height={20} rx={10} className="fill-panel stroke-tour/55" strokeWidth={1.1} />
      <text x={421} y={31.5} textAnchor="middle" className={tourText}>{t("✓ 依然 1 个组 · 单台覆盖即可")}</text>

      {/* Left: Regular devices following Default Group */}
      <MaimaiCabinet x={26} y={46} />
      <text x={48} y={118} textAnchor="middle" className={tagText}>{t("舞萌DX")}</text>

      <ArcadeCabinet x={96} y={44} lit />
      <text x={118} y={118} textAnchor="middle" className={tagText}>{t("中二 / 音击")}</text>

      <g transform="translate(168 50)">
        <rect x={0} y={0} width={76} height={50} rx={8} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <rect x={12} y={7} width={20} height={36} rx={3} className="fill-current text-mint/15 stroke-mint/60" strokeWidth={1.3} />
        <circle cx={27} cy={25} r={1.5} className="fill-current text-mint" />
        <QrMini x={42} y={14} />
      </g>
      <text x={206} y={118} textAnchor="middle" className={tagText}>{t("门锁")}</text>

      {/* Subtle internal divider (NOT a separate group) */}
      <line x1={260} y1={46} x2={260} y2={122} className="stroke-current text-ink/15" strokeWidth={1.2} strokeDasharray="3 3" />

      {/* Right Item 1: Pre-entry Free AC via ¥0 Exclusive Plan */}
      <SplitAcMini x={294} y={46} />
      <rect x={282} y={90} width={100} height={17} rx={8.5} className="fill-panel stroke-tour" strokeWidth={1.2} />
      <text x={332} y={102} textAnchor="middle" className={tourText}>{t("专属：¥0 方案")}</text>
      <text x={332} y={119} textAnchor="middle" className={tagText}>{t("空调（未入场可开）")}</text>

      {/* Right Item 2: Standalone Tabletop via Exclusive / Game Plan */}
      <g transform="translate(458 64) scale(0.76)">
        <TabletopMini cx={0} cy={0} />
      </g>
      <rect x={398} y={90} width={120} height={17} rx={8.5} className="fill-panel stroke-tour" strokeWidth={1.2} />
      <text x={458} y={102} textAnchor="middle" className={tourText}>{t("¥0等位 + 对局¥15/h")}</text>
      <text x={458} y={119} textAnchor="middle" className={tagText}>{t("独立桌游桌")}</text>

      {/* Bottom takeaway pill */}
      <rect x={22} y={134} width={496} height={25} rx={12.5} className="fill-panel stroke-tour/50" strokeWidth={1.2} />
      <text x={270} y={150} textAnchor="middle" className={tagText}>
        {t("个别设备规则不同 → 直接设单台「专属 / 对局方案」覆盖默认组，无需新建组")}
      </text>
    </svg>
  );
}

/** Example 3 ("月宫" + Multi-device VIP Zone): ONLY when a batch of devices share another rate do you add a 2nd group. */
function StoreMultiZoneDiagram() {
  const { t } = useI18n();
  return (
    <svg viewBox="0 0 540 184" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("月宫分区示例：新开多设备包间时新建资源组批量管理")}>
      {/* Left: 1F Hall Default Group */}
      <g transform="translate(10 12)">
        <rect x={0} y={0} width={244} height={160} rx={13} className="fill-current text-mint/[0.06] stroke-mint/55" strokeWidth={1.3} strokeDasharray="5 3" />
        <rect x={12} y={10} width={220} height={20} rx={10} className="fill-current text-mint/20" />
        <circle cx={23} cy={20} r={2.4} className="fill-panel stroke-mint" strokeWidth={1.2} />
        <text x={127} y={23.5} textAnchor="middle" className={mintText}>{t("默认资源组 · ¥4/30分 封顶¥40")}</text>

        <MaimaiCabinet x={20} y={42} />
        <text x={42} y={114} textAnchor="middle" className={tagText}>{t("舞萌DX")}</text>

        <ArcadeCabinet x={98} y={40} lit />
        <text x={120} y={114} textAnchor="middle" className={tagText}>{t("中二节奏")}</text>

        <ArcadeCabinet x={176} y={40} lit />
        <text x={198} y={114} textAnchor="middle" className={tagText}>{t("音击")}</text>

        <text x={122} y={144} textAnchor="middle" className={subText}>{t("一楼大厅 · 多台同价归默认组")}</text>
      </g>

      {/* Right: 2F Multi-device VIP Room Group */}
      <g transform="translate(266 12)">
        <rect x={0} y={0} width={264} height={160} rx={13} className="fill-current text-tour/[0.07] stroke-tour/55" strokeWidth={1.3} strokeDasharray="5 3" />
        <rect x={12} y={10} width={240} height={20} rx={10} className="fill-current text-tour/20" />
        <text x={132} y={23.5} textAnchor="middle" className={tourText}>{t("新建「VIP 包间组」· ¥6/30分")}</text>

        {/* Batch of 4 devices in the VIP room */}
        <MaimaiCabinet x={16} y={42} />
        <text x={38} y={114} textAnchor="middle" className={tagText}>{t("包间舞萌")}</text>

        <ArcadeCabinet x={82} y={40} lit />
        <text x={104} y={114} textAnchor="middle" className={tagText}>{t("包间框体")}</text>

        {/* VIP Door */}
        <g transform="translate(150 46)">
          <rect x={0} y={0} width={44} height={50} rx={7} className="fill-panel stroke-tour/45" strokeWidth={1.2} />
          <rect x={12} y={8} width={20} height={34} rx={3} className="fill-current text-tour/15 stroke-tour" strokeWidth={1.2} />
          <circle cx={27} cy={25} r={1.5} className="fill-current text-tour" />
        </g>
        <text x={172} y={114} textAnchor="middle" className={tagText}>{t("包间门锁")}</text>

        {/* VIP AC */}
        <g transform="translate(202 46)">
          <rect x={0} y={0} width={46} height={50} rx={7} className="fill-panel stroke-tour/45" strokeWidth={1.2} />
          <rect x={6} y={10} width={34} height={14} rx={3} className="fill-current text-mint/15 stroke-mint/60" strokeWidth={1.1} />
          <path d="M 14 28 Q 12 34 16 38 M 23 28 Q 21 34 25 38 M 32 28 Q 30 34 34 38" fill="none" className="stroke-current text-mint/75" strokeWidth={1.2} strokeLinecap="round" />
        </g>
        <text x={225} y={114} textAnchor="middle" className={tagText}>{t("包间空调")}</text>

        <rect x={16} y={128} width={232} height={22} rx={11} className="fill-panel stroke-tour/50" strokeWidth={1.1} />
        <text x={132} y={142.5} textAnchor="middle" className={tourText}>{t("多台设备成批换价 / 停用 · 才建新组")}</text>
      </g>
    </svg>
  );
}

/** 2. Modular Plug-in Loadout: 1 Resource + 10 Icon Modules. */
function ResourceAbilitiesDiagram({ wide = false }: { wide?: boolean }) {
  const { t } = useI18n();
  const modules: Array<{ label: string; draw: () => ReactNode; dashed?: boolean }> = [
    {
      label: "电源",
      draw: () => (
        <g fill="none" className="stroke-current text-mint" strokeWidth={1.7} strokeLinecap="round">
          <path d="M -5 -5 A 7 7 0 1 0 5 -5" />
          <line x1={0} y1={-8} x2={0} y2={0} />
        </g>
      ),
    },
    {
      label: "空调",
      draw: () => (
        <g fill="none" className="stroke-current text-mint" strokeWidth={1.5} strokeLinecap="round">
          <line x1={0} y1={-8} x2={0} y2={8} />
          <line x1={-7} y1={-4} x2={7} y2={4} />
          <line x1={-7} y1={4} x2={7} y2={-4} />
        </g>
      ),
    },
    {
      label: "刷卡 IO",
      draw: () => (
        <g>
          <rect x={-9} y={-6} width={18} height={12} rx={2.5} className="fill-none stroke-current text-mint" strokeWidth={1.5} />
          <line x1={-9} y1={-2} x2={9} y2={-2} className="stroke-current text-mint" strokeWidth={1.5} />
          <rect x={-6} y={1.5} width={4} height={2.5} rx={0.5} className="fill-current text-tour" />
        </g>
      ),
    },
    {
      label: "按键",
      draw: () => (
        <g>
          <rect x={-8} y={-7} width={16} height={14} rx={3} className="fill-none stroke-current text-mint" strokeWidth={1.5} />
          <path d="M -4 2 L 4 2" className="stroke-current text-mint" strokeWidth={1.6} strokeLinecap="round" />
          <circle cx={0} cy={-2} r={1.6} className="fill-current text-mint" />
        </g>
      ),
    },
    {
      label: "投币",
      draw: () => (
        <g>
          <circle cx={0} cy={0} r={7.5} className="fill-current text-tour/20 stroke-tour" strokeWidth={1.5} />
          <line x1={0} y1={-3.5} x2={0} y2={3.5} className="stroke-current text-tour" strokeWidth={1.6} strokeLinecap="round" />
        </g>
      ),
    },
    {
      label: "启动器",
      draw: () => (
        <g>
          <rect x={-9} y={-7} width={18} height={12} rx={2} className="fill-none stroke-current text-mint" strokeWidth={1.5} />
          <polygon points="-2,-3.5 4, -1 -2,1.5" className="fill-current text-mint" />
          <line x1={-4} y1={8} x2={4} y2={8} className="stroke-current text-mint" strokeWidth={1.5} strokeLinecap="round" />
        </g>
      ),
    },
    {
      label: "IoT",
      draw: () => (
        <g className="stroke-current text-mint" fill="none" strokeWidth={1.5} strokeLinecap="round">
          <rect x={-5.5} y={-5.5} width={11} height={11} rx={2} />
          <line x1={-9} y1={-2.5} x2={-5.5} y2={-2.5} /><line x1={-9} y1={2.5} x2={-5.5} y2={2.5} />
          <line x1={5.5} y1={-2.5} x2={9} y2={-2.5} /><line x1={5.5} y1={2.5} x2={9} y2={2.5} />
        </g>
      ),
    },
    {
      label: "门锁",
      draw: () => (
        <g>
          <rect x={-7} y={-2} width={14} height={10} rx={2.5} className="fill-none stroke-current text-mint" strokeWidth={1.5} />
          <path d="M -4 -2 V -5 A 4 4 0 0 1 4 -5 V -2" fill="none" className="stroke-current text-mint" strokeWidth={1.5} />
          <circle cx={0} cy={3} r={1.5} className="fill-current text-tour" />
        </g>
      ),
    },
    {
      label: "桌游",
      draw: () => (
        <g>
          <rect x={-6} y={-6} width={12} height={12} rx={2.5} className="fill-none stroke-current text-tour" strokeWidth={1.5} />
          <circle cx={0} cy={-9} r={1.7} className="fill-current text-tour" />
          <circle cx={0} cy={9} r={1.7} className="fill-current text-tour" />
          <circle cx={-9} cy={0} r={1.7} className="fill-current text-tour" />
          <circle cx={9} cy={0} r={1.7} className="fill-current text-tour" />
        </g>
      ),
    },
    {
      label: "Bot",
      dashed: true,
      draw: () => (
        <g>
          <rect x={-7.5} y={-5.5} width={15} height={12} rx={3.5} className="fill-none stroke-current text-ink/70" strokeWidth={1.5} />
          <circle cx={-3} cy={0} r={1.4} className="fill-current text-mint" />
          <circle cx={3} cy={0} r={1.4} className="fill-current text-mint" />
          <line x1={0} y1={-5.5} x2={0} y2={-8.5} className="stroke-current text-ink/70" strokeWidth={1.4} />
        </g>
      ),
    },
  ];

  return (
    <>
      <svg
        viewBox="0 0 540 162"
        className={`h-auto w-full min-w-[17rem] ${wide ? "lg:hidden" : ""}`}
        role="img"
        aria-label={t("资源与 10 种模块化能力图解")}
      >
        {/* Left Core Resource */}
        <rect x={12} y={16} width={118} height={130} rx={14} className="fill-current text-mint/[0.08] stroke-mint/55" strokeWidth={1.4} />
        <ArcadeCabinet x={26} y={26} lit />
        <QrMini x={82} y={36} />
        <NfcWaves x={88} y={70} />
        <text x={71} y={118} textAnchor="middle" className={mintText}>{t("资源本体")}</text>
        <text x={71} y={133} textAnchor="middle" className={subText}>{t("扫码 / NFC")}</text>

        {/* Plug connector lines */}
        <line x1={130} y1={52} x2={166} y2={52} className="stroke-current text-mint/50" strokeWidth={1.6} strokeDasharray="3 3" />
        <line x1={130} y1={110} x2={166} y2={110} className="stroke-current text-mint/50" strokeWidth={1.6} strokeDasharray="3 3" />
        <circle cx={148} cy={81} r={9} className="fill-current text-mint/15 stroke-mint/60" strokeWidth={1.2} />
        <path d="M 144 81 H 152 M 148 77 V 85" className="stroke-current text-mint" strokeWidth={1.6} strokeLinecap="round" />

        {/* 2x5 Module Grid */}
        {modules.map((m, index) => {
          const col = index % 5;
          const row = Math.floor(index / 5);
          const x = 170 + col * 72;
          const y = 16 + row * 68;
          return (
            <g key={m.label} transform={`translate(${x} ${y})`}>
              <rect
                x={0}
                y={0}
                width={64}
                height={60}
                rx={11}
                strokeWidth={1.2}
                strokeDasharray={m.dashed ? "3 3" : undefined}
                className="fill-panel stroke-ink/20"
              />
              <g transform="translate(32 23)">{m.draw()}</g>
              <text x={32} y={50} textAnchor="middle" className={tagText}>{t(m.label)}</text>
            </g>
          );
        })}
      </svg>
      {wide && (
        <svg
          viewBox="0 0 1040 108"
          className="hidden h-auto w-full lg:block"
          role="img"
          aria-label={t("资源与 10 种模块化能力图解")}
        >
          {/* Left Core Resource */}
          <rect x={10} y={10} width={156} height={88} rx={13} className="fill-current text-mint/[0.08] stroke-mint/55" strokeWidth={1.4} />
          <g transform="translate(18 16) scale(0.84)">
            <ArcadeCabinet x={0} y={0} lit />
          </g>
          <QrMini x={60} y={24} />
          <NfcWaves x={66} y={56} />
          <text x={122} y={50} textAnchor="middle" className={mintText}>{t("资源本体")}</text>
          <text x={122} y={66} textAnchor="middle" className={subText}>{t("扫码 / NFC")}</text>

          {/* Plug connector */}
          <line x1={166} y1={54} x2={202} y2={54} className="stroke-current text-mint/50" strokeWidth={1.6} strokeDasharray="3 3" />
          <circle cx={184} cy={54} r={9} className="fill-current text-mint/15 stroke-mint/60" strokeWidth={1.2} />
          <path d="M 180 54 H 188 M 184 50 V 58" className="stroke-current text-mint" strokeWidth={1.6} strokeLinecap="round" />

          {/* 1x10 Module Strip */}
          {modules.map((m, index) => {
            const x = 206 + index * 82.5;
            return (
              <g key={m.label} transform={`translate(${x} 18)`}>
                <rect
                  x={0}
                  y={0}
                  width={74}
                  height={72}
                  rx={11}
                  strokeWidth={1.2}
                  strokeDasharray={m.dashed ? "3 3" : undefined}
                  className="fill-panel stroke-ink/20"
                />
                <g transform="translate(37 28)">{m.draw()}</g>
                <text x={37} y={58} textAnchor="middle" className={tagText}>{t(m.label)}</text>
              </g>
            );
          })}
        </svg>
      )}
    </>
  );
}

/** 3. Pricing Workbench: Visual Timeline + Stair/Flat/Cap Mini-Charts + Group Binding. */
function PricingWorkbenchDiagram() {
  const { t } = useI18n();
  const arrow = useId();
  return (
    <svg viewBox="0 0 540 164" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("计费工作台与版本生效图解")}>
      <ArrowDefs id={arrow} tone="text-mint" />
      {/* Timeline rail */}
      <line x1={38} y1={24} x2={382} y2={24} className="stroke-current text-ink/20" strokeWidth={2} strokeLinecap="round" />
      <circle cx={68} cy={24} r={5} className="fill-panel stroke-ink/40" strokeWidth={1.5} />
      <text x={68} y={42} textAnchor="middle" className={subText}>{t("历史")}</text>

      <circle cx={200} cy={24} r={7} className="fill-current text-mint" />
      <circle cx={200} cy={24} r={12} className="fill-current text-mint/20" />
      <text x={200} y={43} textAnchor="middle" className={mintText}>{t("现在生效")}</text>

      <circle cx={340} cy={24} r={5.5} className="fill-current text-tour" />
      <text x={340} y={42} textAnchor="middle" className={tourText}>{t("定时调价")}</text>

      {/* 3 Visual Rate Mini-Charts */}
      {/* 1) Stair-step time curve */}
      <g transform="translate(16 58)">
        <rect x={0} y={0} width={116} height={92} rx={11} className="fill-panel stroke-mint/50" strokeWidth={1.3} />
        <polyline points="16,62 38,62 38,46 64,46 64,30 96,30" fill="none" className="stroke-current text-mint" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        <line x1={14} y1={64} x2={100} y2={64} className="stroke-current text-ink/20" strokeWidth={1} />
        <text x={58} y={81} textAnchor="middle" className={mintText}>{t("按时阶梯")}</text>
      </g>

      {/* 2) Flat fee tag */}
      <g transform="translate(142 58)">
        <rect x={0} y={0} width={116} height={92} rx={11} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <rect x={24} y={24} width={68} height={32} rx={7} className="fill-current text-ink/[0.06] stroke-ink/25" strokeWidth={1.2} />
        <circle cx={34} cy={40} r={2.5} className="fill-current text-ink/45" />
        <text x={63} y={44} textAnchor="middle" className={tagText}>¥30</text>
        <text x={58} y={81} textAnchor="middle" className={tagText}>{t("固定收费")}</text>
      </g>

      {/* 3) Spending cap curve */}
      <g transform="translate(268 58)">
        <rect x={0} y={0} width={116} height={92} rx={11} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <line x1={14} y1={26} x2={102} y2={26} strokeDasharray="4 3" className="stroke-current text-coral" strokeWidth={1.5} />
        <text x={98} y={21} textAnchor="end" className="fill-current text-[9px] font-semibold text-coral">MAX</text>
        <polyline points="16,60 54,26 100,26" fill="none" className="stroke-current text-mint" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        <text x={58} y={81} textAnchor="middle" className={tagText}>{t("消费封顶")}</text>
      </g>

      {/* Arrow into Resource Group Binding */}
      <line x1={392} y1={104} x2={420} y2={104} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />
      <g transform="translate(426 42)">
        <rect x={0} y={0} width={102} height={108} rx={12} className="fill-current text-mint/[0.09] stroke-mint/55" strokeWidth={1.4} />
        <rect x={20} y={18} width={62} height={38} rx={7} className="fill-panel stroke-mint/50" strokeWidth={1.2} />
        <line x1={30} y1={32} x2={72} y2={32} className="stroke-current text-mint" strokeWidth={2} strokeLinecap="round" />
        <line x1={30} y1={42} x2={58} y2={42} className="stroke-current text-ink/35" strokeWidth={2} strokeLinecap="round" />
        <text x={51} y={76} textAnchor="middle" className={mintText}>{t("默认组 / 桌游")}</text>
        <text x={51} y={92} textAnchor="middle" className={subText}>{t("保存生效")}</text>
      </g>
    </svg>
  );
}

/** 4. Identity & Bot: Phone Code -> Chat Bubbles -> Synced Player ID Card. */
function IdentityBotDiagram() {
  const { t } = useI18n();
  const arrow = useId();
  return (
    <svg viewBox="0 0 540 156" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("玩家身份验证与 Bot 绑定流程")}>
      <ArrowDefs id={arrow} tone="text-mint" />

      {/* 1) Phone with binding code */}
      <g transform="translate(22 14)">
        <rect x={0} y={0} width={92} height={128} rx={14} className="fill-panel stroke-ink/25" strokeWidth={1.5} />
        <rect x={30} y={7} width={32} height={5} rx={2.5} className="fill-current text-ink/25" />
        <QrMini x={35} y={22} />
        <rect x={12} y={54} width={68} height={28} rx={7} className="fill-current text-mint/15 stroke-mint/50" strokeWidth={1.2} />
        <text x={46} y={72} textAnchor="middle" className="fill-current font-mono text-[11px] font-bold text-mint">AB23CD</text>
        <text x={46} y={108} textAnchor="middle" className={tagText}>{t("扫码拿码")}</text>
      </g>

      <line x1={124} y1={78} x2={156} y2={78} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* 2) Chat window with Bot */}
      <g transform="translate(164 14)">
        <rect x={0} y={0} width={186} height={128} rx={14} className="fill-current text-mint/[0.06] stroke-mint/45" strokeWidth={1.3} />
        {/* User message bubble (right) */}
        <rect x={54} y={18} width={118} height={28} rx={10} className="fill-current text-mint/20 stroke-mint/45" strokeWidth={1} />
        <text x={113} y={36} textAnchor="middle" className={mintText}>/bind AB23CD</text>
        {/* Bot reply (left) */}
        <BotFace cx={32} cy={78} />
        <rect x={56} y={62} width={114} height={30} rx={10} className="fill-panel stroke-ink/20" strokeWidth={1.1} />
        <text x={113} y={81} textAnchor="middle" className={tagText}>{t("✓ 已验证群成员")}</text>
        <text x={93} y={115} textAnchor="middle" className={subText}>{t("首次发给 Bot 即可")}</text>
      </g>

      <line x1={358} y1={78} x2={390} y2={78} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* 3) Synced Player Profile Card */}
      <g transform="translate(398 22)">
        <rect x={0} y={0} width={122} height={112} rx={14} className="fill-panel stroke-ink/25" strokeWidth={1.4} />
        <circle cx={61} cy={36} r={16} className="fill-current text-mint/15 stroke-mint/60" strokeWidth={1.4} />
        <circle cx={61} cy={32} r={5.5} className="fill-current text-mint" />
        <path d="M 51 45 C 53 39, 69 39, 71 45" fill="none" className="stroke-current text-mint" strokeWidth={1.8} strokeLinecap="round" />
        {/* Green verified dot */}
        <circle cx={74} cy={46} r={5.5} className="fill-current text-mint" />
        <path d="M 71.5 46 L 73.3 48 L 76.8 44" fill="none" stroke="#fff" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
        <text x={61} y={74} textAnchor="middle" className={tagText}>{t("群昵称已同步")}</text>
        <text x={61} y={92} textAnchor="middle" className={subText}>{t("支持免 Bot 网页进店")}</text>
      </g>
    </svg>
  );
}

/** 5. Money Flow: Gift Box / Ticket + Top-up -> Stacked Wallet Bar -> 1-2-3 Deduction Slices. */
function MoneyFlowDiagram({ mode }: { mode: OperatingMode }) {
  const { t } = useI18n();
  const arrow = useId();
  const desk = mode === "desk";
  return (
    <svg
      viewBox={desk ? "0 0 540 198" : "0 0 540 154"}
      className="h-auto w-full min-w-[17rem]"
      role="img"
      aria-label={t("钱从哪来、怎么扣图解")}
    >
      <ArrowDefs id={arrow} tone="text-mint" />
      {desk && (
        <g transform="translate(16 10)">
          <rect x={0} y={0} width={508} height={38} rx={10} className="fill-current text-tour/[0.09] stroke-tour/45" strokeWidth={1.2} />
          {/* Card icon */}
          <rect x={16} y={10} width={26} height={18} rx={3} className="fill-panel stroke-tour" strokeWidth={1.4} />
          <line x1={16} y1={16} x2={42} y2={16} className="stroke-current text-tour" strokeWidth={1.4} />
          <text x={54} y={23} className={tourText}>{t("前台刷卡 → 微信 / 支付宝 / 现金直收（不进余额）")}</text>
        </g>
      )}

      <g transform={`translate(0 ${desk ? 52 : 6})`}>
        {/* Left: Perforated Ticket + Gift Box */}
        <g transform="translate(18 14)">
          <rect x={0} y={0} width={128} height={52} rx={10} className="fill-panel stroke-ink/20" strokeWidth={1.3} />
          {/* Perforated ticket */}
          <path d="M 14 14 H 52 V 23 A 4 4 0 0 0 52 31 V 38 H 14 V 31 A 4 4 0 0 0 14 23 Z" className="fill-current text-tour/15 stroke-tour" strokeWidth={1.3} />
          <line x1={38} y1={16} x2={38} y2={36} strokeDasharray="2 2" className="stroke-current text-tour" strokeWidth={1.1} />
          <text x={90} y={26} textAnchor="middle" className={tagText}>{t("兑换码")}</text>
          <text x={90} y={40} textAnchor="middle" className={subText}>{t("建礼物导出")}</text>
        </g>

        <g transform="translate(18 78)">
          <rect x={0} y={0} width={128} height={52} rx={10} className="fill-panel stroke-ink/20" strokeWidth={1.3} />
          {/* Plus coin */}
          <circle cx={33} cy={26} r={13} className="fill-current text-mint/15 stroke-mint" strokeWidth={1.4} />
          <path d="M 28 26 H 38 M 33 21 V 31" className="stroke-current text-mint" strokeWidth={1.8} strokeLinecap="round" />
          <text x={90} y={26} textAnchor="middle" className={tagText}>{t("店员充值")}</text>
          <text x={90} y={40} textAnchor="middle" className={subText}>{t("玩家页加款")}</text>
        </g>

        <path d="M 148 40 L 188 66 M 148 104 L 188 78" fill="none" strokeWidth={1.6} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

        {/* Center: Stacked Battery/Wallet Cylinder */}
        <g transform="translate(196 14)">
          <rect x={0} y={0} width={128} height={116} rx={14} className="fill-panel stroke-mint/55" strokeWidth={1.5} />
          <text x={64} y={22} textAnchor="middle" className={mintText}>{t("玩家钱包")}</text>
          {/* Bonus layer */}
          <rect x={16} y={32} width={96} height={30} rx={7} className="fill-current text-tour/20 stroke-tour/55" strokeWidth={1.2} />
          <text x={64} y={51} textAnchor="middle" className={tourText}>{t("赠金 ¥20")}</text>
          {/* Paid layer */}
          <rect x={16} y={68} width={96} height={34} rx={7} className="fill-current text-mint/20 stroke-mint/60" strokeWidth={1.2} />
          <text x={64} y={89} textAnchor="middle" className={mintText}>{t("本金 ¥100")}</text>
        </g>

        <line x1={328} y1={72} x2={362} y2={72} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

        {/* Right: 1-2-3 Visual Deduction Bars */}
        <g transform="translate(370 14)">
          <rect x={0} y={0} width={152} height={116} rx={14} className="fill-panel stroke-ink/20" strokeWidth={1.3} />
          <text x={76} y={21} textAnchor="middle" className={tagText}>{t("结账扣款顺序")}</text>

          <rect x={14} y={30} width={124} height={21} rx={6} className="fill-current text-coral/15" />
          <text x={24} y={44} className="fill-current text-[10.5px] font-semibold text-coral">{t("① 优惠券")}</text>
          <text x={128} y={44} textAnchor="end" className="fill-current font-mono text-[10px] text-coral">-¥6</text>

          <rect x={14} y={56} width={124} height={21} rx={6} className="fill-current text-tour/15" />
          <text x={24} y={70} className={tourText}>{t("② 赠金")}</text>
          <text x={128} y={70} textAnchor="end" className="fill-current font-mono text-[10px] text-tour">-¥20</text>

          <rect x={14} y={82} width={124} height={21} rx={6} className="fill-current text-mint/15" />
          <text x={24} y={96} className={mintText}>{t("③ 本金")}</text>
          <text x={128} y={96} textAnchor="end" className="fill-current font-mono text-[10px] text-mint">-¥54</text>
        </g>
      </g>
    </svg>
  );
}

/** 6. Cashier Flow: Laptop+USB Reader -> Card Tap Waves -> Stopwatch -> Paid Receipt. */
function CashierFlowDiagram() {
  const { t } = useI18n();
  const arrow = useId();
  return (
    <svg viewBox="0 0 540 140" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("前台刷卡收银流程图")}>
      <ArrowDefs id={arrow} tone="text-mint" />

      {/* Step 1: Desktop Browser + USB Reader */}
      <g transform="translate(14 14)">
        <rect x={0} y={0} width={114} height={112} rx={12} className="fill-panel stroke-ink/20" strokeWidth={1.3} />
        {/* Laptop */}
        <rect x={18} y={20} width={44} height={28} rx={3} className="fill-current text-ink/[0.06] stroke-ink/45" strokeWidth={1.4} />
        <line x1={12} y1={50} x2={68} y2={50} className="stroke-current text-ink/55" strokeWidth={2} strokeLinecap="round" />
        {/* USB cable to Reader pad */}
        <path d="M 62 44 C 74 44, 70 58, 80 58" fill="none" className="stroke-current text-mint" strokeWidth={1.5} />
        <rect x={76} y={48} width={24} height={18} rx={4} className="fill-current text-mint/20 stroke-mint" strokeWidth={1.4} />
        <text x={57} y={84} textAnchor="middle" className={tagText}>{t("1. 连读卡器")}</text>
        <text x={57} y={99} textAnchor="middle" className={subText}>Chrome / Edge</text>
      </g>

      <line x1={132} y1={70} x2={146} y2={70} strokeWidth={1.6} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* Step 2: Physical IC Card Tap */}
      <g transform="translate(150 14)">
        <rect x={0} y={0} width={114} height={112} rx={12} className="fill-current text-mint/[0.07] stroke-mint/50" strokeWidth={1.3} />
        {/* Reader pad */}
        <ellipse cx={57} cy={54} rx={30} ry={10} className="fill-panel stroke-mint/60" strokeWidth={1.3} />
        {/* Tilted card */}
        <g transform="translate(57 34) rotate(-14)">
          <rect x={-22} y={-13} width={44} height={26} rx={4} className="fill-panel stroke-tour" strokeWidth={1.5} />
          <rect x={-15} y={-4} width={8} height={6} rx={1} className="fill-current text-tour" />
        </g>
        <text x={57} y={84} textAnchor="middle" className={mintText}>{t("2. 刷卡入场")}</text>
        <text x={57} y={99} textAnchor="middle" className={subText}>{t("登记昵称计时")}</text>
      </g>

      <line x1={268} y1={70} x2={282} y2={70} strokeWidth={1.6} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* Step 3: Live Timer */}
      <g transform="translate(286 14)">
        <rect x={0} y={0} width={114} height={112} rx={12} className="fill-panel stroke-ink/20" strokeWidth={1.3} />
        <circle cx={57} cy={40} r={19} className="fill-current text-mint/15 stroke-mint" strokeWidth={1.6} />
        <polyline points="57,29 57,41 66,46" fill="none" className="stroke-current text-mint" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        <line x1={52} y1={17} x2={62} y2={17} className="stroke-current text-mint" strokeWidth={1.8} strokeLinecap="round" />
        <text x={57} y={84} textAnchor="middle" className={tagText}>{t("3. 实时计费")}</text>
        <text x={57} y={99} textAnchor="middle" className={subText}>{t("仪表板随时查")}</text>
      </g>

      <line x1={404} y1={70} x2={418} y2={70} strokeWidth={1.6} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* Step 4: On-site Payment Receipt */}
      <g transform="translate(422 14)">
        <rect x={0} y={0} width={104} height={112} rx={12} className="fill-current text-tour/[0.08] stroke-tour/50" strokeWidth={1.3} />
        <rect x={30} y={18} width={44} height={44} rx={8} className="fill-panel stroke-tour/60" strokeWidth={1.4} />
        <path d="M 42 40 L 49 47 L 63 33" fill="none" className="stroke-current text-tour" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        <text x={52} y={84} textAnchor="middle" className={tourText}>{t("4. 现场收款")}</text>
        <text x={52} y={99} textAnchor="middle" className={subText}>{t("微信/支付宝/现")}</text>
      </g>
    </svg>
  );
}

/** 7. QR / NFC Sticker -> iPhone Dynamic Island & Controls -> One-tap Checkout. */
function QrNfcEntryDiagram({ mode }: { mode: OperatingMode }) {
  const { t } = useI18n();
  const arrow = useId();
  return (
    <svg viewBox="0 0 540 156" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("玩家扫码与 NFC 使用流程图")}>
      <ArrowDefs id={arrow} tone="text-mint" />

      {/* Left: Dual QR + NFC Sticker */}
      <g transform="translate(18 20)">
        <rect x={0} y={0} width={132} height={116} rx={14} className="fill-panel stroke-ink/25" strokeWidth={1.4} />
        <g transform="translate(22 24) scale(1.35)">
          <QrMini x={0} y={0} />
        </g>
        <circle cx={92} cy={39} r={17} className="fill-current text-mint/15 stroke-mint/60" strokeWidth={1.3} />
        <NfcWaves x={86} y={35} />
        <text x={66} y={84} textAnchor="middle" className={tagText}>{t("二维码 = NFC")}</text>
        <text x={66} y={100} textAnchor="middle" className={subText}>{t("共用同一链接")}</text>
      </g>

      <line x1={158} y1={78} x2={192} y2={78} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* Center: iPhone with Dynamic Island + Device Controls */}
      <g transform="translate(200 10)">
        <rect x={0} y={0} width={140} height={136} rx={18} className="fill-panel stroke-mint/60" strokeWidth={1.6} />
        {/* Dynamic Island */}
        <rect x={30} y={9} width={80} height={18} rx={9} fill="#111113" />
        <circle cx={42} cy={18} r={3.5} fill="#34d399" />
        <text x={96} y={21.5} textAnchor="end" fill="#ffffff" fontSize="9.5" fontWeight="700" fontFamily="monospace">
          {mode === "devices" ? "PRiSM" : "¥18.0"}
        </text>

        {/* Mini action tiles on phone screen */}
        <rect x={14} y={36} width={52} height={36} rx={8} className="fill-current text-mint/15 stroke-mint/45" strokeWidth={1} />
        <circle cx={40} cy={50} r={5} fill="none" className="stroke-current text-mint" strokeWidth={1.5} />
        <text x={40} y={67} textAnchor="middle" className={subText}>{t("开机")}</text>

        <rect x={74} y={36} width={52} height={36} rx={8} className="fill-current text-tour/15 stroke-tour/45" strokeWidth={1} />
        <circle cx={100} cy={50} r={5} className="fill-current text-tour/30 stroke-tour" strokeWidth={1.4} />
        <text x={100} y={67} textAnchor="middle" className={subText}>{t("投币")}</text>

        <rect x={14} y={80} width={112} height={24} rx={7} className="fill-current text-ink/[0.05]" />
        <text x={70} y={96} textAnchor="middle" className={mintText}>
          {t(mode === "devices" ? "免安装直接控机" : "灵动岛实时看账单")}
        </text>
        <text x={70} y={124} textAnchor="middle" className={subText}>App Clip / Web</text>
      </g>

      <line x1={348} y1={78} x2={382} y2={78} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* Right: Checkout / Machine Running */}
      <g transform="translate(390 20)">
        <rect x={0} y={0} width={132} height={116} rx={14} className="fill-panel stroke-ink/25" strokeWidth={1.4} />
        {mode === "devices" ? (
          <>
            <ArcadeCabinet x={44} y={12} lit />
            <text x={66} y={96} textAnchor="middle" className={tagText}>{t("硬件即刻响应")}</text>
          </>
        ) : (
          <>
            <circle cx={66} cy={42} r={20} className="fill-current text-mint/15 stroke-mint" strokeWidth={1.6} />
            <path d="M 57 42 L 63 48 L 76 35" fill="none" className="stroke-current text-mint" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
            <text x={66} y={82} textAnchor="middle" className={mintText}>{t("离店一键结账")}</text>
            <text x={66} y={98} textAnchor="middle" className={subText}>{t("自动停表扣余额")}</text>
          </>
        )}
      </g>
    </svg>
  );
}

/** 8. TTLock Door: Phone Tap + Location Pin -> Cloud Key -> Keypad Door Lock. */
function TTLockDoorDiagram() {
  const { t } = useI18n();
  const arrow = useId();
  return (
    <svg viewBox="0 0 540 142" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("TTLock 门锁密码生成流程图")}>
      <ArrowDefs id={arrow} tone="text-mint" />

      {/* Phone Unlock + GPS pin */}
      <g transform="translate(20 14)">
        <rect x={0} y={0} width={122} height={114} rx={14} className="fill-panel stroke-ink/20" strokeWidth={1.3} />
        <circle cx={61} cy={42} r={20} className="fill-current text-mint/15 stroke-mint" strokeWidth={1.5} />
        <rect x={54} y={40} width={14} height={11} rx={2.5} className="fill-none stroke-current text-mint" strokeWidth={1.5} />
        <path d="M 57 40 V 35 A 4 4 0 0 1 65 34" fill="none" className="stroke-current text-mint" strokeWidth={1.5} strokeLinecap="round" />
        <text x={61} y={82} textAnchor="middle" className={tagText}>{t("手机点开门")}</text>
        <text x={61} y={98} textAnchor="middle" className={subText}>{t("校验身份与位置")}</text>
      </g>

      <line x1={150} y1={71} x2={188} y2={71} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* Cloud Key Passcode */}
      <g transform="translate(196 14)">
        <rect x={0} y={0} width={148} height={114} rx={14} className="fill-current text-mint/[0.07] stroke-mint/50" strokeWidth={1.3} />
        <rect x={18} y={24} width={112} height={32} rx={8} className="fill-panel stroke-mint/50" strokeWidth={1.2} />
        <text x={74} y={45} textAnchor="middle" className="fill-current font-mono text-[13px] font-bold tracking-widest text-mint">839201#</text>
        <text x={74} y={82} textAnchor="middle" className={mintText}>TTLock API</text>
        <text x={74} y={98} textAnchor="middle" className={subText}>{t("生成临时密码")}</text>
      </g>

      <line x1={352} y1={71} x2={390} y2={71} strokeWidth={1.8} markerEnd={`url(#${arrow})`} className="stroke-current text-mint" />

      {/* Smart Keypad Lock Escutcheon */}
      <g transform="translate(398 10)">
        <rect x={24} y={4} width={74} height={122} rx={14} className="fill-panel stroke-ink/30" strokeWidth={1.6} />
        {/* 3x3 Keypad dots */}
        {[0, 1, 2].map((r) =>
          [0, 1, 2].map((c) => (
            <circle
              key={`${r}-${c}`}
              cx={45 + c * 16}
              cy={26 + r * 14}
              r={3}
              className={(r + c) % 2 === 0 ? "fill-current text-mint" : "fill-current text-ink/35"}
            />
          )),
        )}
        {/* Door handle */}
        <circle cx={61} cy={84} r={7} className="fill-current text-ink/20 stroke-ink/45" strokeWidth={1.4} />
        <rect x={57} y={80} width={38} height={8} rx={4} className="fill-panel stroke-ink/50" strokeWidth={1.4} />
        <text x={61} y={114} textAnchor="middle" className={tagText}>{t("按键开锁")}</text>
      </g>
    </svg>
  );
}

/** 9. Daily Dashboard: Miniature UI Wireframe with Sparklines, Device Dots, and Player Rows. */
function DailyDashboardDiagram() {
  const { t } = useI18n();
  return (
    <svg viewBox="0 0 540 162" className="h-auto w-full min-w-[17rem]" role="img" aria-label={t("日常后台仪表板工作区示意图")}>
      {/* 4 Mini KPI Cards */}
      {/* KPI 1: In-shop headcount */}
      <g transform="translate(12 10)">
        <rect x={0} y={0} width={122} height={50} rx={10} className="fill-panel stroke-mint/50" strokeWidth={1.3} />
        <circle cx={16} cy={16} r={4} fill="#34d399" />
        <text x={26} y={20} className={subText}>{t("在店")}</text>
        <text x={16} y={40} className="fill-current text-[15px] font-bold text-ink">6</text>
        <circle cx={88} cy={32} r={7} className="fill-current text-mint/20" />
        <circle cx={98} cy={32} r={7} className="fill-current text-mint/35" />
      </g>

      {/* KPI 2: Live estimate */}
      <g transform="translate(143 10)">
        <rect x={0} y={0} width={122} height={50} rx={10} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <text x={14} y={20} className={subText}>{t("预估")}</text>
        <text x={14} y={40} className="fill-current text-[14px] font-bold text-ink">¥148</text>
        <rect x={78} y={28} width={6} height={12} rx={2} className="fill-current text-mint/35" />
        <rect x={88} y={22} width={6} height={18} rx={2} className="fill-current text-mint/55" />
        <rect x={98} y={16} width={6} height={24} rx={2} className="fill-current text-mint" />
      </g>

      {/* KPI 3: Revenue sparkline */}
      <g transform="translate(274 10)">
        <rect x={0} y={0} width={122} height={50} rx={10} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <text x={14} y={20} className={subText}>{t("营收")}</text>
        <text x={14} y={40} className="fill-current text-[14px] font-bold text-ink">¥920</text>
        <polyline points="72,38 82,31 90,34 100,22 110,18" fill="none" stroke="#34d399" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* KPI 4: Devices running */}
      <g transform="translate(405 10)">
        <rect x={0} y={0} width={123} height={50} rx={10} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <text x={14} y={20} className={subText}>{t("设备")}</text>
        <text x={14} y={40} className="fill-current text-[14px] font-bold text-ink">8/10</text>
        <circle cx={96} cy={28} r={11} fill="none" className="stroke-current text-ink/15" strokeWidth={3} />
        <path d="M 96 17 A 11 11 0 1 1 86 33" fill="none" className="stroke-current text-mint" strokeWidth={3} strokeLinecap="round" />
      </g>

      {/* Bottom Left: Mini Device Tiles */}
      <g transform="translate(12 70)">
        <rect x={0} y={0} width={253} height={82} rx={12} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <text x={14} y={20} className={tagText}>{t("设备磁贴 · 点击远程控机")}</text>
        {[
          ["1号机", true, "🪙 4"],
          ["2号机", true, "🪙 2"],
          ["空调", true, "24°"],
          ["3号机", false, "OFF"],
        ].map(([name, on, meta], idx) => (
          <g key={String(name)} transform={`translate(${12 + idx * 58} 30)`}>
            <rect x={0} y={0} width={52} height={40} rx={7} className={on ? "fill-current text-mint/[0.09] stroke-mint/45" : "fill-current text-ink/[0.04] stroke-ink/15"} strokeWidth={1} />
            <circle cx={10} cy={11} r={3} className={on ? "fill-current text-mint" : "fill-current text-ink/30"} />
            <text x={26} y={25} textAnchor="middle" className="fill-current text-[9px] font-semibold text-ink">{String(name)}</text>
            <text x={26} y={36} textAnchor="middle" className={subText}>{String(meta)}</text>
          </g>
        ))}
      </g>

      {/* Bottom Right: Mini Live Player Rows */}
      <g transform="translate(275 70)">
        <rect x={0} y={0} width={253} height={82} rx={12} className="fill-panel stroke-ink/20" strokeWidth={1.2} />
        <text x={14} y={20} className={tagText}>{t("在店玩家 · 代结账 / 批量结账")}</text>
        {[0, 1].map((row) => (
          <g key={row} transform={`translate(12 ${28 + row * 24})`}>
            <rect x={0} y={0} width={229} height={20} rx={6} className="fill-current text-ink/[0.04]" />
            <circle cx={12} cy={10} r={5} className="fill-current text-mint/35" />
            <rect x={24} y={7} width={54} height={6} rx={3} className="fill-current text-ink/30" />
            <text x={148} y={13.5} className="fill-current font-mono text-[9.5px] font-semibold text-ink">
              {row === 0 ? "01:20 · ¥30" : "00:45 · ¥15"}
            </text>
            <rect x={190} y={3.5} width={34} height={13} rx={4} className="fill-current text-mint/20" />
            <text x={207} y={12.5} textAnchor="middle" className="fill-current text-[8.5px] font-semibold text-mint">{t("结账")}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
