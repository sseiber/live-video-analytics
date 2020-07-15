# Azure IoT Central live video analytics gateway module
This is an IoT Central gateway module for Azure Media Services LVA edge. The full documentation which shows you how to modify the IoT Edge module code for the live video analytics (LVA) modules can be found at [UPDATE_LINK](https://github.com/Azure/live-video-analytics)

## Prerequisites
To complete the steps in this tutorial, you need:
* [Node.js](https://nodejs.org/en/download/) v13 or later
* [Visual Studio Code](https://code.visualstudio.com/Download) with [TSLint](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-typescript-tslint-plugin) extension installed
* [Docker](https://www.docker.com/products/docker-desktop) engine
* An [Azure Container Registry](https://docs.microsoft.com/azure/container-registry/) to host your versions of the modules
* An [Azure Media Services](https://docs.microsoft.com/azure/media-services/) account.

## Clone the repository
If you haven't already cloned the repository, use the following command to clone it to a suitable location on your local machine:
```
git clone https://github.com/UPDATE_LINK/lva-gateway
```
Open the cloned **lva-gateway** repository folder with VS Code.

## Edit the deployment.amd64.json file
1. If you haven't already done so, create a folder called *storage* in the local copy of the **lva-gateway** repository. This folder is ignored by Git so as to prevent you accidentally checking in any confidential information.
1. Copy the file *deployment.amd64.json* from the setup folder to the storage folder.
1. In VS Code, open the the *storage/deployment.amd64.json* file.
1. Edit the `registryCredentials` section to add your Azure Container Registry credentials.
1. Edit the `LvaEdgeGatewayModule` module section to add the name of your image and your AMS account name in the `env:amsAccountName:value`.
1. See the [Create a live video analytics application in Azure IoT Central UPDATE_LINK](https://github.com/sseiber/lva-gateway/blob/uk/bi8100/docs/azure-docs-pr/articles/iot-central/retail/tutorial-public-safety-create-app.md) for more information about how to complete the configuration.

## Build the code
1. Before you try to build the code for the first time, run the install command. This command installs the required packages and runs the setup scripts.
    ```
    npm install
    ```
1. Edit the *./setup/imageConfig.json* file to update the image named based on your container registry name:
    ```
    {
        "arch": "amd64",
        "imageName": "[Server].azurecr.io/lva-edge-gateway",
        "versionTag": "latest"
    }
    ```
1. Use the VS Code terminal to run the docker login command. Use the same credentials that you provided in the deployment manifest for the modules.
    ```
    docker login [your server].azurecr.io
    ```

1. Use the VS Code terminal to run the commands to build the image and push it to your docker container registry. The build scripts deploy the image to your container registry. The output in the VS Code terminal window shows you if the build is successful.
    ```
    npm run dockerbuild
    npm run dockerpush
    ```
