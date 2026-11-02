# 视频项目的均匀性脚本（照搬，不要改）

`render.py`、`uni.py`、`export_maps.py` 复制自视频项目（小米 18 Pro Max 那期）的
`tools/uniformity/`。只改了 `render.py` 第 11 行：原文件把 NAS 的绝对路径写成默认数据目录，库内副本
去掉了这个默认值（`make_maps.py` 总是自己设置目录），算法一个字没动。`data/uniformity_metrics.json` 和库里所有均匀度数字、热力图都出自这三个文件。
`../make_maps.py` 在运行时改它们的输入目录、机型列表和矩阵读取（CSV），不改算法；每个热力图包的
manifest.json 都记着这三个文件的 sha256。

| 文件 | sha256 |
|---|---|
| render.py | 387fc7e478512dc73d40ea0d2590a0df4f45c6a23fc942d57d1058f4768bdf63（原文件 63b9b453ca7ec56499f2a6017ca4d73063e5bbed6ce949ec3721ff3eb53c5fb4） |
| uni.py | ec467f134d8ea3fcf467e5ddd7b031d720cb8990721bd3d0498a3980af2deba4 |
| export_maps.py | 2ab1e9bdcd19f6de3494b3018d202b7c0d80b595c164ddeac8af84f57162c635 |
