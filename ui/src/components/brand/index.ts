// The Ruah brand kit: the mark, the Phantom and its family, and the page states built on them.
//   Phantom / PhantomCompanion   eight expressions (idle, thinking, tracking, agent, success,
//                                loading, warning, error) — Phantom.tsx
//   PhantomPose                  19 poses (sleeping, celebrating, reading, building, searching,
//                                cloud, infra, terminal, detective, traveler, keyholder, headset,
//                                waving, charting, plugging, painting, checklist, chatting,
//                                mapping) — PhantomPose.tsx + phantom-figures.tsx
//   PhantomAgent                 each coding agent's tinted ghost (claude, cursor, grok, kiro,
//                                opencode)
//   PhantomScene                 group scenes: duo, trio, handoff, party, crew
//   EmptyState                   page empty / loading / error state with a ghost
// The dev sheet at /_ghosts shows all of them in every palette × theme.
export {
  Eye,
  EXPRESSION_CONFIG,
  PHANTOM_EXPRESSIONS,
  PHANTOM_SIZES,
  Phantom,
  PhantomCompanion,
  SEMANTIC_TONES,
  canonicalTone,
  toneVar,
  type CanonicalTone,
  type EyeShape,
  type PhantomExpression,
  type PhantomProps,
  type PhantomSize,
  type PhantomTone,
  type SemanticTone,
} from "./Phantom";
export {
  POSES,
  POSE_NAMES,
  PhantomAgent,
  PhantomPose,
  PhantomScene,
  SCENE_NAMES,
  agentTintOf,
  expressionTone,
  sceneRole,
  type PhantomAgentProps,
  type PhantomPoseName,
  type PhantomPoseProps,
  type PhantomSceneName,
  type PhantomSceneProps,
} from "./PhantomPose";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { RUAH_BODY_PATH, RuahLogo, RuahMark } from "./RuahLogo";
export { agentExpressionLabel, agentExpressionOf, useAgentExpression } from "./agentExpression";
