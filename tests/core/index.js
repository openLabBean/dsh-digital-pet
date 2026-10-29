/**
 * Node 22 directory-argument shim.
 *
 * Node 22.x 的 `node --test` 把位置参数当作 glob 模式（不再递归展开目录），
 * 因此 `node --test tests/core/` 会把 `tests/core` 目录本身当成测试文件去加载。
 * 该 commit 的验收命令恰为 `cd plugins/dsh-digital-pet && node --test tests/core/`，
 * 故在此提供 index.js：目录被 CJS 解析时会落到 index.js，从而在同一进程内
 * 加载全部测试文件，保证该命令退出码为 0。
 *
 * Node 23+ / Node 22 之后支持目录语义的版本会忽略本文件（默认测试文件
 * 匹配规则不包含 index.js），`node --test "tests/core/*.test.js"` 的逐文件
 * 报告也不受影响。
 */
import './time.test.js';
import './growth.test.js';
import './state.test.js';
import './economy.test.js';
import './settle.test.js';
import './water.test.js';
import './waste.test.js';
import './actions.test.js';
import './needs.test.js';
import './offline.test.js';
import './boarding.test.js';
import './death.test.js';
