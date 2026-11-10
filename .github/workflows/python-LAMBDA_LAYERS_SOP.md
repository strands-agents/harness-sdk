# Lambda Layers Standard Operating Procedures (SOP)

## Overview

This document defines the standard operating procedures for managing Strands Agents Lambda layers across all AWS regions, Python versions, and architectures.

**Total: 136 individual Lambda layers** (17 regions × 2 architectures × 4 Python versions). All variants must maintain the same layer version number for each PyPI package version, with only one row per PyPI version appearing in documentation.

## Deployment Process

### 1. Initial Deployment
1. Run workflow with ALL options selected (default)
2. Specify PyPI package version
3. Type "Create Lambda Layer {package_version}" to confirm
4. All 136 individual layers deploy in parallel (4 Python × 2 arch × 17 regions)
5. Each layer gets its own unique name: `strands-agents-py{PYTHON_VERSION}-{ARCH}`

### 2. Version Buffering for New Variants
When adding new variants (new Python version, architecture, or region):

1. **Determine target layer version**: Check existing variants to find the highest layer version
2. **Buffer deployment**: Deploy new variants multiple times until layer version matches existing variants
3. **Example**: If existing variants are at layer version 5, deploy new variant 5 times to reach version 5

### 3. Handling Transient Failures
When some regions fail during deployment:

1. **Identify failed regions**: Check which combinations didn't complete successfully
2. **Targeted redeployment**: Use specific region/arch/Python inputs to redeploy failed combinations
3. **Version alignment**: Continue deploying until all variants reach the same layer version
4. **Verification**: Confirm all combinations have identical layer versions before updating docs