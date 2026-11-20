export type ToolMode =
  | 'select'
  | 'pan'
  | 'ruler'
  | 'fog'
  | 'paint'
  | 'los-wall'
  | 'los-door'
  | 'los-secret-door'
  | 'los-erase'
  | 'place-light';

export type PaintToolMode =
  | 'brush'
  | 'text'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'select-rect';

export type ShapeFillMode = 'outline' | 'fill' | 'both';

export interface PaintState {
  tool: PaintToolMode;
  primaryColor: string;
  secondaryColor: string;
  size: number;
  opacity: number;
  fillMode: ShapeFillMode;
  fontSize: number;
}

export type PaintObject =
  | {
      id: number;
      type: 'brush';
      points: Point[];
      color: string;
      size: number;
      opacity: number;
      rotation?: number;
    }
  | {
      id: number;
      type: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      size: number;
      opacity: number;
      rotation?: number;
    }
  | {
      id: number;
      type: 'rect' | 'ellipse';
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
      secondaryColor: string;
      fillMode: ShapeFillMode;
      size: number;
      opacity: number;
      rotation?: number;
    }
  | {
      id: number;
      type: 'text';
      x: number;
      y: number;
      text: string;
      color: string;
      fontSize: number;
      opacity: number;
      rotation?: number;
    };

export type FogTool = 'reveal' | 'hide';

export type WallType = 'wall' | 'door';

export interface Point {
  x: number;
  y: number;
}

export interface CellCoord {
  col: number;
  row: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WallSegment extends Segment {
  id: number;
  type: WallType;
  open: boolean;
  secret?: boolean;
  revealed?: boolean;
  version?: number;
}

export interface DraftWall extends Segment {
  pointerId: number;
  type: WallType;
}

export interface Token {
  id: number;
  ownerId?: number | null;
  x: number;
  y: number;
  color: string;
  label: string;
  size?: number;
  rotation?: number;
  version?: number;
}

export interface GridState {
  size: number;
  offsetX: number;
  offsetY: number;
  visible: boolean;
  color?: string;
  opacity?: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface FogState {
  enabled: boolean;
  peek: boolean;
  tool: FogTool;
  brushSize: number;
}

export type AmbientLightLevel = 'bright' | 'normal' | 'dim' | 'darkness';

export type VisionMode = 'normal' | 'low-light' | 'darkvision';

export type LightKind = 'mundane' | 'light-spell' | 'darkness-spell';

export interface LightPreset {
  name: string;
  kind: LightKind;
  spellLevel: number;
  innerRadiusFt: number;
  outerRadiusFt: number;
  color: string;
}

export interface LightSource {
  id: number;
  ownerId: number | null;
  attachedTokenId: number | null;
  name: string;
  kind: LightKind;
  spellLevel: number;
  x: number;
  y: number;
  enabled: boolean;
  innerRadiusFt: number;
  outerRadiusFt: number;
  color: string;
}

export interface LightingState {
  enabled: boolean;
  ambient: AmbientLightLevel;
  visionMode: VisionMode;
}

export interface LosState {
  enabled: boolean;
  peek: boolean;
}

export interface ActiveDrag {
  token: Token;
  offsetX: number;
  offsetY: number;
  startCol: number;
  startRow: number;
}

export interface ActiveRuler {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export interface VisibilityHit extends Point {
  angle: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GridDetectionResult {
  size: number;
  offsetX: number;
  offsetY: number;
  confidence: number;
}

export interface FloatingWindowOptions {
  title?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number | 'auto';
  tabs?: string[];
  rotatable?: boolean;
  collapsible?: boolean;
  closable?: boolean;
  defaultCollapsed?: boolean;
  storageKey?: string;
  onClose?: () => void;
  resizable?: boolean | 'horizontal';
}

export interface FloatingWindowState {
  x: number;
  y: number;
  w: number;
  h: number | 'auto';
  rotation: number;
  collapsed: boolean;
  activeTab: string | null;
  open: boolean;
}

export interface FloatingWindowInstance {
  win: HTMLElement;
  body: HTMLDivElement;
  tabPanes: Record<string, HTMLDivElement>;
  state: FloatingWindowState;
  render: () => void;
  setOpen: (open: boolean) => void;
  setTabVisible?: (tabName: string, visible: boolean) => void;
}

export interface AccordionSection {
  section: HTMLDivElement;
  body: HTMLDivElement;
}

export type UserRole = 'gm' | 'player';
export type MembershipStatus = 'active' | 'revoked';

export interface UserCampaignAssignment {
  campaignId: number;
  campaignName: string;
  role: UserRole;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  isAdmin?: boolean;
  isActive?: boolean;
  campaignId?: number | null;
  membershipStatus?: MembershipStatus;
  createdAt?: string;
  campaigns?: UserCampaignAssignment[];
}

export interface CampaignMember {
  userId: number;
  username: string;
  displayName: string;
  role: UserRole;
  status: MembershipStatus;
}

export interface CampaignSummary {
  id: number;
  name: string;
  createdAt: string;
  myRole: UserRole;
  members: CampaignMember[];
}

export interface AuditLogEntry {
  id: number;
  userId: number | null;
  username: string;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export type DiagonalRuleMode = '5-10-5' | '1-1-1' | 'euclidean';

export interface RulesConfig {
  diagonalRule: DiagonalRuleMode;
  feetPerSquare: number;
  allowPlayerDoors: boolean;
}

export interface RuleRecord {
  id: number;
  key: string;
  title: string;
  category: string;
  value: Record<string, unknown>;
  updatedAt: string;
}

export interface SceneSummary {
  id: number;
  name: string;
  isActive: boolean;
  isDefault?: boolean;
  updatedAt: string;
  hasMap: boolean;
}

export interface SceneData {
  id: number;
  name: string;
  seq?: number;
  version?: number;
  isActive: boolean;
  updatedAt: string;
  hasMap: boolean;
  hasFog: boolean;
  hasPaint?: boolean;
  grid: GridState;
  camera: CameraState;
  fog: {
    enabled: boolean;
    peek: boolean;
    brushSize: number;
  };
  los: LosState;
  tokens: Token[];
  walls: WallSegment[];
  paintObjects?: PaintObject[];
  lighting?: { enabled: boolean; ambient: AmbientLightLevel };
  lights?: LightSource[];
}

export interface ChatMessage {
  id: number;
  senderName: string;
  message: string;
  rollResult: string | null;
  createdAt: string;
}

export interface SavedMapSummary {
  id: number;
  name: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

