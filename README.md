# AuctionMC

一个 Node.js 服务端 + 浏览器客户端的多人竞拍网页游戏。服务端只维护一个房间，最多 4 名玩家，通过 WebSocket 同步房间、对局、出价、道具和仓库操作。

## 环境要求

- Node.js 18 或更新版本。
- 项目目录需要允许写入 `saves/` 和 `logs/`。
- 不需要数据库。

## 启动指令

```powershell
npm start
```

等价于：

```powershell
node server.js
```

开发时也可以使用：

```powershell
npm run dev
```

服务端监听端口来自 `config.json` 的 `port` 字段，默认是 `3000`。启动后访问：

- 房间入口：`http://localhost:3000/`
- Wiki：`http://localhost:3000/wiki`
- 战利品仓测试：`http://localhost:3000/test_warehouse`

## 配置文件

主要配置在 `config.json`：

- `port`：唯一监听端口，默认 `3000`。
- `containers`：准备阶段随机抽取的战利品容器，键是容器名称，值是生成算法参数 `k`。
- `warehouse.price_bias_ratio`：同品质内按价格生成权重的偏置倍率。
- `warehouse.rarity_base_weights`：六种品质的基础权重。
- `warehouse.volume_min` / `volume_max`：战利品总体积范围。
- `warehouse.volume_normal_mean` / `volume_normal_stddev`：总体积正态分布参数。
- `game.system_hint_probability`：第二回合起，每回合发放公开系统提示的概率。

修改配置后需要重启服务端。

## 数据和资源

- `items.csv`：战利品定义。图片按物品 id 放在 `resource/auction/`。
- `props.csv`：道具定义。图片放在 `resource/props/`。
- `characters.csv`：角色定义。图片放在 `resource/characters/`。
- `note.txt`：品质、类型等注释信息。
- `resource/audio/`：音效资源。
- `public/`：浏览器端页面、样式和脚本。

CSV 更新后通常只需要刷新页面；服务端逻辑使用的定义会在新一局或新请求中重新读取对应模块的数据。

## 存档

玩家档案保存在 `saves/玩家昵称.json`。档案包含：

- `money`：玩家金钱。
- `warehouse.items`：私人战利品数量和收藏状态。
- `warehouse.props`：持有道具数量。
- 道具携带配置等后续游戏数据。

建议部署前定期备份 `saves/`。

## 日志

服务端日志写入：

```text
logs/server.log
```

日志是 JSONL 格式，每行一条记录。服务端启动、对局开始/结束、未捕获异常、未处理 Promise rejection、角色技能异常等都会写入这里。服务器崩溃或技能异常时先检查这个文件。

## 页面说明

- `/` 或 `/room`：输入昵称并进入准备房间。
- `/wiki`：公开图鉴页面，不需要 WebSocket，不需要登录。
- `/warehouse?playerId=临时id`：私人仓库页面，需要当前房间内有效玩家 id。
- `/shop?playerId=临时id`：商城页面，需要当前房间内有效玩家 id。
- `/game?playerId=临时id`：对局页面，由房间开始游戏后进入。
- `/test_warehouse?k=1.0`：本地测试战利品仓生成；`k` 是生成算法参数。

## 部署建议

1. 将项目目录复制到服务器。
2. 确认 Node.js 已安装。
3. 设置 `config.json` 中的 `port`。
4. 确认 `saves/`、`logs/` 可写。
5. 执行 `npm start`。
6. 如果需要公网访问，可在反向代理中转发 HTTP 和 WebSocket 到该端口。

Windows 长期运行可以使用 `nssm`、任务计划程序或其他进程守护工具；Linux 可以使用 `systemd` 或 `pm2`。无论使用哪种方式，工作目录都应指向项目根目录。

## 常见排查

- 端口被占用：修改 `config.json` 的 `port` 或停止占用端口的进程。
- 图片不显示：检查 CSV 中的 `image` 路径，确认资源文件存在。
- 无法进入仓库/商城：确认 URL 中的 `playerId` 是当前房间内玩家的临时 id，且玩家没有掉线退出。
- 技能或道具无效果：先查看 `logs/server.log`，再核对 `characters.csv` / `props.csv` 中的 id 和资源定义。
- 战利品生成异常：运行 `node --check server.js` 检查语法，再打开 `/test_warehouse` 测试生成。
