# Agent Pivot Attention UI Bridge

The Agent Pivot Attention UI Bridge is a required local UI-host dependency and
companion for Agent Pivot. It is not a standalone user feature and has no user-facing commands.

The bridge lets Agent Pivot workspace extensions in local, SSH, WSL, and Dev
Container environments exchange bounded attention and open-workspace
coordination records through the local UI host's VS Code extension storage.
Install it on the local UI host; installing the main Agent Pivot extension in a
remote workspace host is not a substitute for the local companion.

The bridge records workspace and root URIs locally for open-workspace coordination. Those URIs can include absolute local paths or remote-authority identifiers.
The bridge does not record conversation content, prompts, or responses.

Agent Pivot began as a fork of Kruemelkatze/vscode-dashboard and retains the upstream MIT attribution.

See the repository [LICENSE](https://github.com/hzcheng/agent-pivot/blob/main/LICENSE) and
[Third-Party Notices](https://github.com/hzcheng/agent-pivot/blob/main/THIRD_PARTY_NOTICES.md).
