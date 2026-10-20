pipeline {
    agent none
    stages {
        stage('Lint') {
            agent { docker { image 'node:20-alpine' } }
            steps { sh 'npm ci && npm run lint' }
        }
        stage('Tests') {
            parallel {
                stage('Unit') {
                    agent { label 'linux' }
                    steps { sh 'npm test' }
                }
                stage('Windows') {
                    agent { label 'windows' }
                    steps { bat 'npm test' }
                }
                stage('Integration') {
                    agent any
                    when { branch 'main' }
                    steps {
                        sh 'docker compose up -d'
                        sh 'npm run test:integration'
                    }
                    post { always { sh 'docker compose down' } }
                }
            }
        }
        stage('Cross-platform build') {
            matrix {
                axes {
                    axis { name 'PLATFORM'; values 'linux', 'darwin' }
                    axis { name 'ARCH'; values 'amd64', 'arm64' }
                }
                excludes {
                    exclude {
                        axis { name 'PLATFORM'; values 'darwin' }
                        axis { name 'ARCH'; values 'amd64' }
                    }
                }
                agent any
                stages {
                    stage('Build') {
                        steps { sh 'GOOS=${PLATFORM} GOARCH=${ARCH} go build -o out/app-${PLATFORM}-${ARCH} .' }
                    }
                }
            }
        }
        stage('Release') {
            agent any
            when { tag 'v*' }
            steps {
                input message: 'Publish release?'
                sh './release.sh'
            }
        }
    }
}
