# 实验一：二手交易系统需求分析

本仓库只保存实验一的需求分析材料，不包含任何系统实现代码。

## 文件

- `requirements.md`：最终需求规格说明书（29 条需求，含状态转换、数据关系、异常和验收标准）
- `chat.txt`：访谈与补充沟通、AI 交互记录、人工审查记录
- `report.html` / `report.pdf`：需求分析报告

## Git 标签

- `lab1-ai-draft`：AI 第一次生成的需求初稿和首次 AI 交互记录
- `lab1-final`：人工审查后的最终需求与完整记录

标签创建后不得移动、删除或覆盖。

## 提交信息

- 学号：241220039
- 姓名：徐梓皓

## 公开仓库

公开 Git 仓库地址尚未创建/填写。创建后执行：

```bash
git remote add origin <你的公开仓库URL>
git push -u origin main
git push origin lab1-ai-draft lab1-final
```

推送后把仓库地址填入 `report.pdf` 的版本信息。**只修改报告，不要移动两个 Git 标签。**

## WSL 仓库

已复制到 Ubuntu-24.04 的以下路径：

```text
/home/xzh/lab1-secondhand-trading
```

进入方式：

```bash
wsl -d Ubuntu-24.04
cd ~/lab1-secondhand-trading
git status
git log --oneline --decorate -5
git tag
```

## 提交包

当前提交包：

```text
C:\Users\Xzh\Desktop\软工\提交包\实验1_241220039_徐梓皓.zip
```

压缩包内只有：

```text
实验1_241220039_徐梓皓/
├── report.pdf
├── requirements.md
└── chat.txt
```

`requirements.md` 和 `chat.txt` 与 `lab1-final` 标签中的同名文件内容完全相同。
