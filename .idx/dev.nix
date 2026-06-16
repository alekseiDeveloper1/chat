# To learn more about how to use Nix to configure your environment
# see: https://google.com
{ pkgs, ... }: {
  # Which nixpkgs channel to use.
  channel = "stable-24.11";
  
  # Use https://nixos.org to find packages
  packages = [
    pkgs.nodejs_22
    pkgs.yarn
    pkgs.nodePackages.typescript-language-server
    pkgs.jdk17
  ];

  # Sets environment variables in the workspace
  env = { 
    EXPO_USE_FAST_RESOLVER = "1";
    JAVA_HOME = "${pkgs.jdk17}/lib/openjdk";
  };

  idx = {
    # Search for the extensions you want on https://open-vsx.org and use "publisher.id"
    extensions = [
      "msjsdiag.vscode-react-native"
    ];

    workspace = {
      # Runs when a workspace is first created with this `dev.nix` file
      onCreate = {
        install = "yarn install";
      };
      
      onStart = {};
    };

    previews = {
      enable = true;
      previews = {
        web = {
          command = [ "yarn" "web" "--" "--port" "$PORT" ];
          manager = "web";
        };
        android = {
          command = [ "yarn" "android" ];
          manager = "web"; 
        };
      };
    };

  };
}
