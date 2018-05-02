#!/usr/bin/env python

import json
import os;
import subprocess

def generate(output, node_script, src, dst):
  cmd = ["node", node_script, src, os.path.abspath(dst)]
  os.chdir(os.path.dirname(node_script))
  subprocess.check_call(cmd)
