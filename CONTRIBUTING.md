# Contributing to Consuela

First off, thanks for taking the time to contribute! Consuela welcomes contributions from everyone.

## Contributor License Agreement (CLA)

**Important:** By submitting a pull request or patch to this repository, you agree to the following terms:

1. You grant the Consuela project maintainers a **perpetual, worldwide, non-exclusive, royalty-free, irrevocable license** to use, reproduce, modify, sublicense, and distribute your contribution under any license, including proprietary commercial licenses.

2. You represent that you have the legal right to grant the above license. If your employer has rights to intellectual property that you create, you represent that you have received permission to make the contribution on behalf of that employer.

3. You understand that your contribution will be publicly available under the AGPL-3.0 license, but may also be offered under alternative commercial licensing terms.

This CLA allows us to offer Consuela under dual licensing (open source AGPL + commercial) while accepting community contributions.

## How to Contribute

### Reporting Bugs

- Check if the bug has already been reported in [Issues](../../issues)
- If not, create a new issue with:
  - A clear, descriptive title
  - Steps to reproduce
  - Expected vs actual behavior
  - Your environment (Node.js version, OS, etc.)

### Suggesting Features

- Open an issue with the `enhancement` label
- Describe the feature and why it would be useful
- Be open to discussion about implementation approaches

### Pull Requests

1. Fork the repo and create your branch from `main`
2. Run `npm install` to install dependencies
3. Make your changes
4. Add tests if applicable
5. Run `npm test` to ensure all tests pass
6. Run `npm run build` to ensure it compiles
7. Submit your PR

### Code Style

- We use TypeScript with strict mode
- Run `npm run build` to check for type errors
- Keep functions small and focused
- Add comments for complex logic

### Commit Messages

- Use clear, descriptive commit messages
- Start with a verb: "Add", "Fix", "Update", "Remove"
- Reference issues when relevant: "Fix #123"

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/consuela.git
cd consuela

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Link locally for testing
npm link
consuela --help
```

## Questions?

Feel free to open an issue for any questions about contributing.

---

**By contributing to Consuela, you agree to the CLA terms above.**
