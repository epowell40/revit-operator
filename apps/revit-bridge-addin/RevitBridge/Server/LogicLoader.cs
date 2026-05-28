using System;
using System.IO;
using System.Reflection;
using RevitBridge.Common;

namespace RevitBridge.Server
{
    public class LogicLoader
    {
        private ILogicService _currentLogic;
        private DateTime _lastLoadTime = DateTime.MinValue;
        private string _dllPath;

        public LogicLoader(string dllPath)
        {
            _dllPath = dllPath;
        }

        public ILogicService GetLogic()
        {
            if (ShouldReload())
            {
                Load();
            }
            return _currentLogic;
        }

        private bool ShouldReload()
        {
            if (_currentLogic == null) return true;
            if (!File.Exists(_dllPath)) return false;
            
            // Check if file is newer than last load
            return File.GetLastWriteTime(_dllPath) > _lastLoadTime;
        }

        private void Load()
        {
            try 
            {
                if (!File.Exists(_dllPath)) return;

                // Load bytes to avoid locking the file
                byte[] dllBytes = File.ReadAllBytes(_dllPath);
                
                string pdbPath = Path.ChangeExtension(_dllPath, ".pdb");
                byte[] pdbBytes = File.Exists(pdbPath) ? File.ReadAllBytes(pdbPath) : null;

                // Load assembly
                Assembly asm;
                if (pdbBytes != null)
                    asm = Assembly.Load(dllBytes, pdbBytes);
                else
                    asm = Assembly.Load(dllBytes);
                
                // Find LogicService
                Type serviceType = asm.GetType("RevitBridge.Logic.LogicService");
                if (serviceType == null) throw new Exception("LogicService type not found in loaded DLL");

                // Instantiate
                _currentLogic = (ILogicService)Activator.CreateInstance(serviceType);
                _lastLoadTime = File.GetLastWriteTime(_dllPath);
            }
            catch (Exception ex)
            {
                // In a real app, log to a file
                // For now, we swallow or maybe return null so server can report error?
                // Throwing will be caught by Server's try/catch
                throw new Exception($"Failed to load Logic DLL from {_dllPath}: {ex.Message}", ex);
            }
        }
    }
}