const { execSync } = require('child_process');

try {
  // Try to get the Python version
  const pythonVersion = execSync('python3 --version || python --version', { stdio: 'pipe' }).toString();
  console.log(`Python is installed: ${pythonVersion}`);
} catch (error) {
  console.error(
    '\nPython is required to install this package.\n' +
    'Please install Python and try again. Instructions:\n' +
    '- macOS: Install with "brew install python"\n' +
    '- Linux: Install with your package manager (e.g., "sudo apt install python3")\n' +
    '- Windows: Download from https://www.python.org/downloads/\n'
  );
  process.exit(1); // Exit the installation with an error
}