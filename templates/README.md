# Extension Templates

Starter templates for creating new AgentOS extensions.

## Available Templates

### 📦 basic-tool
Basic extension template with a single tool implementation.
- Simple ITool interface example
- Unit test setup
- TypeScript configuration
- Best for: Single-purpose tools

### 🔧 multi-tool (Coming Soon)
Template for extensions with multiple related tools.
- Multiple tool implementations
- Shared services
- Integration tests
- Best for: Tool suites

### 🛡️ guardrail (Coming Soon)
Template for creating guardrail extensions.
- IGuardrail interface
- Policy enforcement
- Best for: Safety and compliance tools

### 🔄 workflow (Coming Soon)
Template for workflow extensions.
- Multi-step processes
- Agent coordination
- Best for: Complex automation

## Using a Template

```bash
# Copy template
cp -r templates/basic-tool community/category/your-extension-name

# Navigate to your extension
cd community/category/your-extension-name

# Update package.json
# Change name from @framers/agentos-ext-template to @framers/agentos-{category}-{name}

# Install and develop
npm install
npm run dev
```

## Template Structure

All templates include:
- ✅ TypeScript configuration
- ✅ Testing setup (Vitest)
- ✅ Apache-2.0 license
- ✅ Manifest file
- ✅ README template
- ✅ CI/CD ready

## Creating Your Extension

1. Choose appropriate template
2. Copy to correct category folder
3. Update naming and metadata
4. Implement your functionality
5. Write tests (>80% coverage)
6. Document usage
7. Submit PR

See [CONTRIBUTING.md](../CONTRIBUTING.md) for full guidelines.
