import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v0_5_0_0 } from './v0.5.0_0'
import { v0_4_1_0 } from './v0.4.1_0'
import { v0_1_0_0 } from './v0.1.0_0'
import { v0_2_0_0 } from './v0.2.0_0'
import { v0_3_0_0 } from './v0.3.0_0'
import { v0_4_0_0 } from './v0.4.0_0'

export const versionGraph = VersionGraph.of({
  current,
  other: [v0_1_0_0, v0_2_0_0, v0_3_0_0, v0_4_0_0, v0_4_1_0, v0_5_0_0],
})
